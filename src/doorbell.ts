import { BinarySensor } from '@scrypted/sdk';
import { ArloDeviceProvider } from './main';

import { DeviceSummary, DeviceStatus, DeviceRegistration } from './base-station-api-client';
import { ArloCameraDevice } from './camera';

export class ArloDoorbellDevice extends ArloCameraDevice implements BinarySensor {
    private buttonTimeout?: NodeJS.Timeout;

    constructor(public provider: ArloDeviceProvider, nativeId: string, deviceSummary: DeviceSummary, deviceRegistration: DeviceRegistration, deviceStatus: DeviceStatus) {
        super(provider, nativeId, deviceSummary, deviceRegistration, deviceStatus);
        this.binaryState = false;
    }

    /** BinarySensor */

    onButtonPressed(triggered: boolean) {
        this.binaryState = triggered;
        this.resetButtonTimeout();
    }

    resetButtonTimeout() {
        clearTimeout(this.buttonTimeout);
        this.buttonTimeout = setTimeout(() => { this.binaryState = false; }, 10000);
    }
}