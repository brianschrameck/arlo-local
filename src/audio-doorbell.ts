import { Battery, Camera, FFmpegInput, MediaObject, MotionSensor, PictureOptions, ResponseMediaStreamOptions, ScryptedDeviceBase, Setting, Settings, SettingValue, VideoCamera, ScryptedMimeTypes, RequestMediaStreamOptions, BinarySensor } from '@scrypted/sdk';
import sdk from '@scrypted/sdk';
import { ArloDeviceProvider } from './main';

import { DeviceSummary, DeviceStatus, AudioDoorbellRegistration, DeviceRegistration } from './base-station-api-client';
import { ArloDeviceBase } from './arlo-device-base';
const { systemManager, mediaManager } = sdk;

export class ArloAudioDoorbellDevice extends ArloDeviceBase implements BinarySensor {
    private buttonTimeout?: NodeJS.Timeout;

    constructor(public provider: ArloDeviceProvider, nativeId: string, deviceSummary: DeviceSummary, deviceRegistration: DeviceRegistration, deviceStatus: DeviceStatus) {
        super(provider, nativeId, deviceSummary, deviceRegistration, deviceStatus);
        this.binaryState = false;
    }

    onButtonPressed(triggered: boolean) {
        this.binaryState = triggered;
        this.resetButtonTimeout();
    }

    resetButtonTimeout() {
        clearTimeout(this.buttonTimeout);
        this.buttonTimeout = setTimeout(() => { this.binaryState = false; }, 10000);
    }
}