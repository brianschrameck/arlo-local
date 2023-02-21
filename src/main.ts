import { Device, DeviceDiscovery, DeviceProvider, HttpRequest, HttpRequestHandler, HttpResponse, ScryptedDeviceBase, ScryptedDeviceType, ScryptedInterface, Setting, Settings, SettingValue } from '@scrypted/sdk';
import sdk from '@scrypted/sdk';
import { BaseStationApiClient, DeviceSummary, MotionDetectedEvent, DeviceStatus, StatusUpdatedEvent, WebhookEvent, ButtonPressedEvent, DeviceRegistration, AudioDoorbellStatus, RegisteredEvent } from './base-station-api-client';
import { ArloDeviceBase } from './arlo-device-base';
import { ArloAudioDoorbellDevice } from './audio-doorbell';
import { ArloCameraDevice } from './camera';

const { deviceManager } = sdk;
const MOTION_SLUG = 'motionDetected';
const REGISTRATION_SLUG = 'registered';
const STATUS_SLUG = 'statusUpdated';
const BUTTON_PRESS_SLUG = 'buttonPressed';

class ArloDeviceProvider extends ScryptedDeviceBase implements DeviceProvider, DeviceDiscovery, Settings, HttpRequestHandler {
    private arloRawDevices = new Map<string, ArloRawDevice>();
    private arloDevices = new Map<string, ArloDeviceBase>();
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
            }, {
                title: 'Registration Webhook',
                description: 'To get registrations from your devices (e.g. a new device gets added) adjust StatusUpdateWebHookUrl in arlo-cam-api\'s config.yaml file.',
                type: 'string',
                readonly: true,
                value: await this.getWebhookUrl(REGISTRATION_SLUG),
            }, {
                title: 'Status Update Webhook',
                description: 'To get status updates from your devices (e.g. battery level) adjust StatusUpdateWebHookUrl in arlo-cam-api\'s config.yaml file.',
                type: 'string',
                readonly: true,
                value: await this.getWebhookUrl(STATUS_SLUG),
            }, {
                title: 'Motion Sensor Webhook',
                description: 'To get motion alerts, adjust MotionRecordingWebHookUrl in arlo-cam-api\'s config.yaml file.',
                type: 'string',
                readonly: true,
                value: await this.getWebhookUrl(MOTION_SLUG),
            }, {
                title: 'Button Press Webhook',
                description: 'To get button press events from your doorbells, adjust ButtonPressWebHookUrl in arlo-cam-api\'s config.yaml file.',
                type: 'string',
                readonly: true,
                value: await this.getWebhookUrl(BUTTON_PRESS_SLUG),
            }
        ];
    }

    private getArloHost(): string {
        return this.storage.getItem('arloHost');
    }

    private async getWebhookUrl(slug: string): Promise<string> {
        this.console.info(`getting ${slug} webhook`)
        const webhookUrl = await sdk.endpointManager.getLocalEndpoint(this.nativeId, { insecure: true, public: true });
        return `${webhookUrl}${slug}`;
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
        } else if (request.url?.endsWith(REGISTRATION_SLUG)) {
            const registeredEvent: RegisteredEvent = JSON.parse(request.body);
            if (this.webhookEventIsValid(registeredEvent, response)) {
                const registration = JSON.parse(registeredEvent.registration);
                (await this.getDevice(registeredEvent.serial_number)).onRegistrationUpdated(registration);
            } else {
                return;
            }
        } else if (request.url?.endsWith(STATUS_SLUG)) {
            const statusUpdatedEvent: StatusUpdatedEvent = JSON.parse(request.body);
            if (this.webhookEventIsValid(statusUpdatedEvent, response)) {
                const status = JSON.parse(statusUpdatedEvent.status);
                (await this.getDevice(statusUpdatedEvent.serial_number)).onStatusUpdated(status);
            } else {
                return;
            }
        } else if (request.url?.endsWith(BUTTON_PRESS_SLUG)) {
            const buttonPressedEvent: ButtonPressedEvent = JSON.parse(request.body);
            if (this.webhookEventIsValid(buttonPressedEvent, response)) {
                const device = (await this.getDevice(buttonPressedEvent.serial_number))
                if (device instanceof ArloAudioDoorbellDevice) {
                    device.onButtonPressed(buttonPressedEvent.triggered.toLowerCase() === 'true');
                }
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
        this.arloRawDevices.clear();
        this.arloDevices.clear();

        const scryptedDevices: Device[] = [];

        this.baseStationApiClient = new BaseStationApiClient(`${arloHost}`);
        let listDevicesResponse: DeviceSummary[];
        try {
            listDevicesResponse = await this.baseStationApiClient.listDevices();
            if (listDevicesResponse.length === 0) {
                this.console.warn('Connection to local Arlo device API succeeded, but no devices were returned.');
                return;
            }
        } catch (error) {
            this.console.error(`There was an issue connecting to your local Arlo device API. Please check your settings and try again. ${error}`);
            return;
        };

        await Promise.allSettled(listDevicesResponse.map(async (deviceSummary: DeviceSummary) => {
            const serialNumber = deviceSummary.serial_number;

            let deviceRegistration: DeviceRegistration;
            try {
                deviceRegistration = await this.baseStationApiClient.getRegistration(serialNumber);
                this.console.debug(`Registration retrieved for ${serialNumber}.`);
            } catch (error) {
                this.console.warn(`Registration retrieval failed for ${serialNumber}; device may not operate correctly. Error: ${error}`);
            }

            let deviceStatus: DeviceStatus;
            try {
                deviceStatus = await this.baseStationApiClient.getStatus(serialNumber);
                this.console.debug(`Status retrieved for ${serialNumber}.`);
            } catch (error) {
                this.console.warn(`Status retrieval failed for ${serialNumber}; device may not operate correctly. Error: ${error}`);
            }

            const arloRawDevice: ArloRawDevice = { deviceSummary, deviceRegistration, deviceStatus };
            this.arloRawDevices.set(deviceSummary.serial_number, arloRawDevice);
            scryptedDevices.push(this.createScryptedDevice(arloRawDevice));

            this.console.info(`Discovered device ${arloRawDevice.deviceSummary.serial_number}`);
        }));

        await deviceManager.onDevicesChanged({
            providerNativeId: this.nativeId,
            devices: scryptedDevices,
        });

        this.console.log(`Discovered ${scryptedDevices.length} devices.`);
    }

    createScryptedDevice(arloRawDevice: ArloRawDevice): Device {
        const interfaces = ArloDeviceProvider.getDeviceInterfaces(arloRawDevice.deviceRegistration, arloRawDevice.deviceStatus);

        return {
            name: arloRawDevice.deviceSummary.friendly_name,
            nativeId: arloRawDevice.deviceSummary.serial_number,
            type: interfaces.includes(ScryptedInterface.VideoCamera) ? ScryptedDeviceType.Camera : ScryptedDeviceType.Sensor,
            interfaces: interfaces,
            info: {
                firmware: arloRawDevice.deviceStatus?.SystemFirmwareVersion,
                manufacturer: 'Arlo Technologies, Inc.',
                model: arloRawDevice.deviceRegistration?.SystemModelNumber,
                serialNumber: arloRawDevice.deviceStatus?.SystemSerialNumber,
                version: arloRawDevice.deviceStatus?.HardwareRevision,
            },
            providerNativeId: this.nativeId,
        };
    }

    /** DeviceProvider */

    async releaseDevice(id: string, nativeId: string): Promise<void> {
        // Does nothing.
    }

    async getDevice(nativeId: string): Promise<ArloDeviceBase> {
        if (this.arloDevices.has(nativeId))
            return this.arloDevices.get(nativeId);
        const arloRawDevice = this.arloRawDevices.get(nativeId);
        if (!arloRawDevice)
            throw new Error('device not found?');

        const deviceSummary = arloRawDevice.deviceSummary;
        const deviceRegistration = arloRawDevice.deviceRegistration;
        const deviceStatus = arloRawDevice.deviceStatus;

        const interfaces = ArloDeviceProvider.getDeviceInterfaces(deviceRegistration, deviceStatus);
        let retDevice: ArloDeviceBase;
        if (interfaces.includes(ScryptedInterface.VideoCamera)) {
            retDevice = new ArloCameraDevice(this, nativeId, deviceSummary, deviceRegistration, deviceStatus);
        } else if (interfaces.includes(ScryptedInterface.BinarySensor)) {
            retDevice = new ArloAudioDoorbellDevice(this, nativeId, deviceSummary, deviceRegistration, deviceStatus);
            this.console.log('returning doorbell device with interfaces: ' + retDevice.interfaces);
        } else {
            throw new Error('unknown device type');
        }

        this.arloDevices.set(nativeId, retDevice);
        return retDevice;
    }

    private static getDeviceInterfaces(deviceRegistration: DeviceRegistration, deviceStatus: DeviceStatus): string[] {
        let interfaces = [
            ScryptedInterface.Settings
        ];

        for (const capability of deviceRegistration?.Capabilities) {
            switch (capability) {
                case 'H.264Streaming':
                    interfaces.push(ScryptedInterface.VideoCamera);
                    break;
                case 'BatteryLevel':
                    interfaces.push(ScryptedInterface.Battery);
                    break;
                case 'PirMotion':
                    interfaces.push(ScryptedInterface.MotionSensor);
                    break;
                case 'JPEGSnapshot':
                    interfaces.push(ScryptedInterface.Camera);
                    break;
                default:
                    break;
            }
        }

        // sadly, Arlo doesn't report a specific capability for doorbells, so we check if the status includes a count of button press events
        if ((deviceStatus as AudioDoorbellStatus)?.ButtonEvents !== undefined) {
            interfaces.push(ScryptedInterface.BinarySensor);
        }

        return interfaces;
    }
}

class ArloRawDevice {
    deviceSummary: DeviceSummary;
    deviceRegistration?: DeviceRegistration;
    deviceStatus?: DeviceStatus;
}

export { ArloDeviceProvider };

export default new ArloDeviceProvider();
