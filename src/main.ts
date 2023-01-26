import { Device, DeviceDiscovery, DeviceProvider, ScryptedDeviceBase, ScryptedDeviceType, ScryptedInterface, Setting, Settings, SettingValue } from '@scrypted/sdk';
import sdk from '@scrypted/sdk';
import { StorageSettings } from "@scrypted/sdk/storage-settings"
import { ArloCamera } from './camera';
import { BaseStationApiClient, BaseStationCameraSummary, BaseStationCameraResponse, BaseStationCameraStatus } from './base-station-api-client';

const { deviceManager } = sdk;

class ArloCameraPlugin extends ScryptedDeviceBase implements DeviceProvider, DeviceDiscovery, Settings {
    arloDevices = new Map<string, ArloCamera>();
    baseStationApiClient?: BaseStationApiClient;

    settingsStorage = new StorageSettings(this, {
        arloHost: {
            title: 'Base Station API Host',
            description: 'The URL of your arlo-cam-api, including protocol and port.',
            placeholder: 'http://192.168.1.100:5000',
            onPut: async () => this.discoverDevices(0),
        },
    });

    /** Settings */

    getSettings(): Promise<Setting[]> {
        return this.settingsStorage.getSettings();
    }

    putSetting(key: string, value: SettingValue): Promise<void> {
        return this.settingsStorage.putSetting(key, value);
    }

    /** DeviceDiscovery */

    async discoverDevices(duration?: number) {
        this.console.info("Discovering devices...")
        this.arloDevices.clear();
        const devices: Device[] = [];

        const arloHost = this.settingsStorage.getItem('arloHost');
        this.baseStationApiClient = new BaseStationApiClient(`${arloHost}`);
        const listCamerasResponse = await this.baseStationApiClient.listCameras();
        if (!listCamerasResponse) {
            return;
        }
        const cameraSummaries = new Map(listCamerasResponse.map((obj) => [obj.serial_number, obj]));

        // generate a new status for each camera in parallel
        const generateStatusPromises: Promise<BaseStationCameraResponse>[] = [];
        cameraSummaries.forEach((cameraSummary: BaseStationCameraSummary) => {
            const serialNumber = cameraSummary.serial_number;
            const generateStatusPromise = this.baseStationApiClient.postGenerateStatusRequest(serialNumber);
            generateStatusPromises.push(generateStatusPromise);
            generateStatusPromise.catch(error => {
                this.console.error(`Status update request failed for ${serialNumber}; skipping.Error: ${error} `);
            });
        });

        // wait for all of the requests to finish
        const generateStatusPromiseResults = await Promise.allSettled(generateStatusPromises);

        // request the status from each camera in parallel
        const statusPromises: Promise<BaseStationCameraStatus>[] = [];

        for (const generateStatusPromiseResult of generateStatusPromiseResults) {
            if (generateStatusPromiseResult.status === 'fulfilled') {
                const serialNumber = generateStatusPromiseResult.value.serialNumber
                if (generateStatusPromiseResult.value.result) {
                    this.console.debug(`Status update request succeeded for ${serialNumber}; continuing to retrieve status.`);
                } else {
                    this.console.error(`Status update request reached ${serialNumber}, but failed for some reason; skipping.`);
                    continue;
                }

                const statusPromise = this.baseStationApiClient.getCameraStatus(serialNumber);
                statusPromises.push(statusPromise);
                statusPromise.catch(error => {
                    this.console.error(`Status retrieval failed for ${serialNumber}; skipping. Error: ${error}`);
                });
            }
        }

        // wait for all of the requests to finish
        const statusPromiseResults = await Promise.allSettled(statusPromises);

        // parse the responses from each camera
        for (const statusPromiseResult of statusPromiseResults) {
            if (statusPromiseResult.status === 'fulfilled') {
                const cameraStatus = statusPromiseResult.value;
                const serialNumber = cameraStatus.SystemSerialNumber;
                this.console.debug(`Status retrieved for ${serialNumber}.`);
                const cameraSummary = cameraSummaries.get(serialNumber);
                const arloCamera = new ArloCamera(this, cameraSummary.serial_number, cameraSummary, cameraStatus);
                this.arloDevices.set(arloCamera.nativeId, arloCamera);

                devices.push({
                    name: arloCamera.cameraSummary.friendly_name,
                    nativeId: arloCamera.nativeId,
                    type: ScryptedDeviceType.Camera,
                    interfaces: [
                        ScryptedInterface.Camera,
                        ScryptedInterface.VideoCamera,
                        ScryptedInterface.Settings,
                    ],
                    info: {
                        firmware: arloCamera.cameraStatus.SystemFirmwareVersion,
                        manufacturer: 'Arlo Technologies, Inc.',
                        model: arloCamera.cameraStatus.UpdateSystemModelNumber,
                        serialNumber: arloCamera.cameraStatus.SystemSerialNumber,
                        version: arloCamera.cameraStatus.HardwareRevision,
                    },
                });

                this.console.info(`Discovered device ${arloCamera.nativeId}`);
            }
        }

        await deviceManager.onDevicesChanged({
            devices,
        });

        this.console.log(`Discovered ${devices.length} devices.`);
    }

    /** DeviceProvider */

    async releaseDevice(id: string, nativeId: string): Promise<void> {
        // Does nothing.
    }

    async getDevice(nativeId: string) {
        return this.arloDevices.get(nativeId);
    }
}

export { ArloCameraPlugin };

export default new ArloCameraPlugin();
