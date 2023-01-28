import { Device, DeviceDiscovery, DeviceProvider, HttpRequest, HttpRequestHandler, HttpResponse, ScryptedDeviceBase, ScryptedDeviceType, ScryptedInterface, Setting, Settings, SettingValue } from '@scrypted/sdk';
import sdk from '@scrypted/sdk';
import { ArloCameraDevice } from './camera';
import { BaseStationApiClient, BaseStationCameraSummary, MotionDetectedEvent, BaseStationCameraStatus } from './base-station-api-client';

const { deviceManager } = sdk;

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
            }
        ];
    }

    private getArloHost(): string {
        return this.storage.getItem('arloHost');
    }

    private async getMotionDetectedWebhookUrl(): Promise<string> {
        this.console.info('getting webhook')
        const webhookUrl = await sdk.endpointManager.getLocalEndpoint(this.nativeId, { insecure: true, public: true });
        return `${webhookUrl}motionDetected`;
    }

    async putSetting(key: string, value: SettingValue) {
        this.storage.setItem(key, value.toString());
        await this.discoverDevices();
    }

    /** HttpRequestHandler */
    async onRequest(request: HttpRequest, response: HttpResponse): Promise<void> {
        if (request.url.endsWith('/motionDetected')) {
            const motionDetectedEvent: MotionDetectedEvent = JSON.parse(request.body);
            if (!motionDetectedEvent.serial_number) {
                response.send('Missing serial_number in body', {
                    code: 400,
                });
                return;
            }
            if (!this.arloCameraDevices.has(motionDetectedEvent.serial_number)) {
                response.send(`Serial number ${motionDetectedEvent.serial_number} not found`, {
                    code: 500,
                });
                return;
            }

            this.arloCameraDevices.get(motionDetectedEvent.serial_number).onMotionDetected();
        }

        this.console.info(`Received webhook request: ${request.body}`);
        response.send('OK');
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
        const listCamerasResponse = await this.baseStationApiClient.listCameras();
        if (!listCamerasResponse) {
            return;
        }

        await Promise.allSettled(listCamerasResponse.map(async (cameraSummary: BaseStationCameraSummary) => {
            // generate a new status for each camera
            const serialNumber = cameraSummary.serial_number;
            try {
                const generateStatusResponse = await this.baseStationApiClient.postGenerateStatusRequest(serialNumber);
                if (generateStatusResponse.result) {
                    this.console.debug(`Status update request succeeded for ${serialNumber}; continuing to retrieve status.`);
                } else {
                    this.console.error(`Status update request reached ${serialNumber}, but failed for some reason; skipping.`);
                    return;
                }
            } catch (error) {
                this.console.error(`Status update request failed for ${serialNumber}; skipping.Error: ${error} `);
                return;
            };

            try {
                const cameraStatus = await this.baseStationApiClient.getCameraStatus(serialNumber);
                this.console.debug(`Status retrieved for ${serialNumber}.`);

                const arloCamera: ArloCamera = { cameraSummary, cameraStatus };
                this.arloCameras.set(cameraSummary.serial_number, arloCamera);
                scryptedDevices.push(this.createScryptedDevice(arloCamera));

                this.console.info(`Discovered device ${arloCamera.cameraSummary.serial_number}`);
            } catch (error) {
                this.console.error(`Status retrieval failed for ${serialNumber}; skipping. Error: ${error}`);
                return;
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
            interfaces: [
                // ScryptedInterface.Battery, TODO re-add this later when we start getting status updates
                ScryptedInterface.Camera,
                ScryptedInterface.MotionSensor,
                ScryptedInterface.Settings,
                ScryptedInterface.VideoCamera,
            ],
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

    async getDevice(nativeId: string): Promise<any> {
        if (this.arloCameraDevices.has(nativeId))
            return this.arloCameraDevices.get(nativeId);
        const arloCamera = this.arloCameras.get(nativeId);
        if (!arloCamera)
            throw new Error('camera not found?');
        const ret = new ArloCameraDevice(this, nativeId, arloCamera.cameraSummary, arloCamera.cameraStatus);
        this.arloCameraDevices.set(nativeId, ret);
        return ret;
    }

    async updateDeviceInterfaces(nativeId: string, interfaces: string[]) {
        let device = this.createScryptedDevice(this.arloCameras.get(nativeId));
        device.interfaces = interfaces;
        deviceManager.onDeviceDiscovered(device)
    }
}

interface ArloCamera {
    cameraSummary: BaseStationCameraSummary,
    cameraStatus: BaseStationCameraStatus,
}

export { ArloCameraProvider as ArloCameraProvider };

export default new ArloCameraProvider();
