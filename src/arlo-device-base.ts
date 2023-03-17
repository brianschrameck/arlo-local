import { Battery, MotionSensor, ScryptedDeviceBase, Setting, Settings, SettingValue } from '@scrypted/sdk';
import { ArloDeviceProvider } from './main';

import { DeviceSummary, DeviceStatus, DeviceRegistration, CameraStatus } from './base-station-api-client';

const DEFAULT_MOTION_TIMEOUT = 10; // seconds

export class ArloDeviceBase extends ScryptedDeviceBase implements Battery, MotionSensor, Settings {
    motionTimeout?: NodeJS.Timeout;
    deviceSummary: DeviceSummary;
    deviceRegistration: DeviceRegistration;
    deviceStatus: DeviceStatus;
    externallyPowered: boolean = false;

    constructor(public provider: ArloDeviceProvider, nativeId: string, deviceSummary: DeviceSummary, deviceRegistration: DeviceRegistration, deviceStatus: DeviceStatus) {
        super(nativeId);
        this.motionDetected = false;
        this.deviceSummary = deviceSummary;
        this.onRegistrationUpdated(deviceRegistration);
        this.onStatusUpdated(deviceStatus)
    }

    onRegistrationUpdated(deviceRegistration: DeviceRegistration) {
        this.deviceRegistration = deviceRegistration;
        this.batteryLevel = this.deviceRegistration.BatPercent || this.deviceRegistration.BatteryPercentage;
    }

    onStatusUpdated(deviceStatus: DeviceStatus) {
        this.deviceStatus = deviceStatus;
        this.batteryLevel = this.deviceStatus.BatPercent || this.deviceStatus.BatteryPercentage;
        // if the charger tech is present and includes QuickCharger or Regular, then we are externally powered
        const chargerTech = (this.deviceStatus as CameraStatus)?.ChargerTech;
        this.externallyPowered = chargerTech && ['QuickCharger', 'Regular'].includes(chargerTech);
    }

    /** MotionSensor */

    onMotionDetected() {
        this.motionDetected = true;
        this.resetMotionTimeout();
    }

    resetMotionTimeout() {
        clearTimeout(this.motionTimeout);
        this.motionTimeout = setTimeout(() => { this.motionDetected = false; }, this.getMotionSensorTimeout() * 1000);
    }

    /** Settings */

    // implement
    async getSettings(): Promise<Setting[]> {
        return [
            {
                key: 'motionSensorTimeout',
                title: 'Motion Sensor Timeout',
                type: 'integer',
                value: this.getMotionSensorTimeout(),
                description: 'Time to wait in seconds before clearing the motion detected state.',
            },
            {
                key: 'isAudioDisabled',
                title: 'No Audio',
                description: 'Enable this setting if the device does not have audio or to mute audio.',
                type: 'boolean',
                value: (this.isAudioDisabled()).toString(),
            },
            {
                key: 'isDeviceDisabled',
                title: 'Disable Device',
                description: 'Enable this setting if you want to disable this device. All motion and video processing will be disabled.',
                type: 'boolean',
                value: (this.isDeviceDisabled()).toString(),
            }
        ];
    }

    // implement
    async putSetting(key: string, value: SettingValue) {
        this.storage.setItem(key, value.toString());
    }

    getMotionSensorTimeout() {
        return parseInt(this.storage.getItem('motionSensorTimeout')) || DEFAULT_MOTION_TIMEOUT;
    }

    isAudioDisabled() {
        return this.storage.getItem('isAudioDisabled') === 'true' || this.deviceRegistration.SystemModelNumber === 'VMC3030';
    }

    isDeviceDisabled() {
        return this.storage.getItem('isDeviceDisabled') === 'true';
    }
}