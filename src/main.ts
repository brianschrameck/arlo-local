import { Device, DeviceDiscovery, DeviceProvider, HttpRequest, HttpRequestHandler, HttpResponse, ScryptedDeviceBase, ScryptedDeviceType, ScryptedInterface, Setting, Settings, SettingValue } from '@scrypted/sdk';
import sdk from '@scrypted/sdk';
import { ArloCameraDevice } from './camera';
import { BaseStationApiClient, CameraSummary, MotionDetectedEvent, CameraStatus, StatusUpdatedEvent, WebhookEvent } from './base-station-api-client';

const { deviceManager } = sdk;
const MOTION_SLUG = 'motionDetected';
const STATUS_SLUG = 'statusUpdated';

class ArloCameraProvider extends ScryptedDeviceBase implements DeviceProvider, DeviceDiscovery, Settings, HttpRequestHandler {
    private arloCameras = new Map<string, ArloCamera>();
    private arloCameraDevices = new Map<string, ArloCameraDevice>();
    baseStationApiClient?: BaseStationApiClient;

    constructor(nativeId?: string) {
        super(nativeId);
        this.discoverDevices();
    }

    /** Settings */

    async getSettings(): Promise<Setting[]> {
        return [
            {
                key: 'arloHost',
                title: 'Base Station API Host',
                description: 'The URL of your arlo-cam-api, including protocol and port.',
                placeholder: 'http://192.168.1.100:5000',
                type: 'string',
                value: this.getArloHost()
            },
            {
                title: 'Motion Sensor Webhook',
                description: 'To get motion alerts, adjust MotionRecordingWebHookUrl in arlo-cam-api\'s config.yaml file.',
                type: 'string',
                readonly: true,
                value: await this.getMotionDetectedWebhookUrl(),
            },
            {
                title: 'Status Update Webhook',
                description: 'To get status updates from your cameras (e.g. battery level) adjust StatusUpdateWebHookUrl in arlo-cam-api\'s config.yaml file.',
                type: 'string',
                readonly: true,
                value: await this.getStatusUpdatedWebhookUrl(),
            }
        ];
    }

    private getArloHost(): string {
        return this.storage.getItem('arloHost');
    }

    private async getMotionDetectedWebhookUrl(): Promise<string> {
        this.console.info(`getting ${MOTION_SLUG} webhook`)
        const webhookUrl = await sdk.endpointManager.getLocalEndpoint(this.nativeId, { insecure: true, public: true });
        return `${webhookUrl}${MOTION_SLUG}`;
    }

    private async getStatusUpdatedWebhookUrl(): Promise<string> {
        this.console.info(`getting ${STATUS_SLUG} webhook`)
        const webhookUrl = await sdk.endpointManager.getLocalEndpoint(this.nativeId, { insecure: true, public: true });
        return `${webhookUrl}${STATUS_SLUG}`;
    }

    async putSetting(key: string, value: SettingValue) {
        this.storage.setItem(key, value.toString());
        await this.discoverDevices();
    }

    /** HttpRequestHandler */

    async onRequest(request: HttpRequest, response: HttpResponse): Promise<void> {
        this.console.info(`Received webhook request: ${request.body}`);

        if (request.url?.endsWith(MOTION_SLUG)) {
            const motionDetectedEvent: MotionDetectedEvent = JSON.parse(request.body);
            if (this.webhookEventIsValid(motionDetectedEvent, response)) {
                (await this.getDevice(motionDetectedEvent.serial_number)).onMotionDetected();
            } else {
                return;
            }
        } else if (request.url?.endsWith(STATUS_SLUG)) {
            const statusUpdatedEvent: StatusUpdatedEvent = JSON.parse(request.body);
            const status = JSON.parse(statusUpdatedEvent.status);
            if (this.webhookEventIsValid(statusUpdatedEvent, response)) {
                (await this.getDevice(statusUpdatedEvent.serial_number)).onStatusUpdated(status);
            } else {
                return;
            }
        }

        response.send('OK');
    }

    private webhookEventIsValid(event: WebhookEvent, response: HttpResponse): boolean {
        if (!event.serial_number) {
            const err = 'Missing serial_number in body';
            this.console.error(err);
            response.send(err, {
                code: 400,
            });
            return false;
        } else if (!this.getDevice(event.serial_number)) {
            const err = `Serial number ${event.serial_number} not found`;
            this.console.error(err);
            response.send(err, {
                code: 500,
            });
            return false;
        }
        return true;
    }

    /** DeviceDiscovery */

    async discoverDevices(duration?: number) {
        const arloHost = this.getArloHost();
        if (!arloHost) {
            this.console.log("Enter API host information in the settings to discover your devices.");
            return;
        }

        this.console.info("Discovering devices...")
        this.arloCameras.clear();
        this.arloCameraDevices.clear();

        const scryptedDevices: Device[] = [];

        this.baseStationApiClient = new BaseStationApiClient(`${arloHost}`);
        let listCamerasResponse: CameraSummary[];
        try {
            listCamerasResponse = await this.baseStationApiClient.listCameras();
            if (listCamerasResponse.length === 0) {
                this.console.warn('Connection to camera API succeeded, but no devices were returned.');
                return;
            }
        } catch (error) {
            this.console.error(`There was an issue connecting to your camera API. Please check your settings and try again. ${error}`);
            return;
        };

        await Promise.allSettled(listCamerasResponse.map(async (cameraSummary: CameraSummary) => {
            const serialNumber = cameraSummary.serial_number;

            try {
                const cameraStatus = await this.baseStationApiClient.getCameraStatus(serialNumber);
                this.console.debug(`Status retrieved for ${serialNumber}.`);

                const arloCamera: ArloCamera = { cameraSummary, cameraStatus };
                this.arloCameras.set(cameraSummary.serial_number, arloCamera);
                scryptedDevices.push(this.createScryptedDevice(arloCamera));

                this.console.info(`Discovered device ${arloCamera.cameraSummary.serial_number}`);
            } catch (error) {
                this.console.warn(`Status retrieval failed for ${serialNumber}; camera may not operate correctly. Error: ${error}`);
            }
        }));

        await deviceManager.onDevicesChanged({
            providerNativeId: this.nativeId,
            devices: scryptedDevices,
        });

        this.console.log(`Discovered ${scryptedDevices.length} devices.`);
    }

    createScryptedDevice(arloCamera: ArloCamera): Device {
        return {
            name: arloCamera.cameraSummary.friendly_name,
            nativeId: arloCamera.cameraSummary.serial_number,
            type: ScryptedDeviceType.Camera,
            interfaces: ArloCameraProvider.getDeviceInterfaces(arloCamera.cameraStatus),
            info: {
                firmware: arloCamera.cameraStatus.SystemFirmwareVersion,
                manufacturer: 'Arlo Technologies, Inc.',
                model: arloCamera.cameraStatus.UpdateSystemModelNumber,
                serialNumber: arloCamera.cameraStatus.SystemSerialNumber,
                version: arloCamera.cameraStatus.HardwareRevision,
            },
            providerNativeId: this.nativeId,
        };
    }

    /** DeviceProvider */

    async releaseDevice(id: string, nativeId: string): Promise<void> {
        // Does nothing.
    }

    async getDevice(nativeId: string): Promise<ArloCameraDevice> {
        if (this.arloCameraDevices.has(nativeId))
            return this.arloCameraDevices.get(nativeId);
        const arloCamera = this.arloCameras.get(nativeId);
        if (!arloCamera)
            throw new Error('camera not found?');
        const ret = new ArloCameraDevice(this, nativeId, arloCamera.cameraSummary, arloCamera.cameraStatus);
        this.arloCameraDevices.set(nativeId, ret);
        return ret;
    }

    async updateDevice(nativeId: string, cameraStatus: CameraStatus) {
        const arloCamera = this.arloCameras.get(nativeId);
        arloCamera.cameraStatus = cameraStatus;
        const device = this.createScryptedDevice(arloCamera);
        deviceManager.onDeviceDiscovered(device);
        this.console.info(`Updated device interfaces to: ${device.interfaces}`)
    }

    private static getDeviceInterfaces(cameraStatus: CameraStatus): string[] {
        let interfaces = [
            ScryptedInterface.Camera,
            ScryptedInterface.MotionSensor,
            ScryptedInterface.Settings,
            ScryptedInterface.VideoCamera,
        ];

        // only add the Battery interface if we are not on power
        if (!['QuickCharger', 'Regular'].includes(cameraStatus.ChargerTech)) {
            interfaces.push(ScryptedInterface.Battery);
        } else {
            console.info('Ignoring Battery interface because camera is plugged in.');
        }

        return interfaces;
    }
}

class ArloCamera {
    cameraSummary: CameraSummary;
    cameraStatus: CameraStatus;
}

export { ArloCameraProvider as ArloCameraProvider };

export default new ArloCameraProvider();
