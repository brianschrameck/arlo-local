import { Camera, FFmpegInput, MediaObject, PictureOptions, ResponseMediaStreamOptions, VideoCamera, ScryptedMimeTypes, Setting } from '@scrypted/sdk';
import sdk from '@scrypted/sdk';
import { RtspUdpProxy } from './rtsp-proxy';

import { DeviceRegistration, DeviceStatus } from './base-station-api-client';
import { ArloDeviceBase } from './arlo-device-base';
import { sleep } from './sleep';

const { mediaManager } = sdk;

const REFRESH_TIMEOUT = 40000; // milliseconds (rebroadcast refreshes 30 seconds before the specified refreshAt time)
const STREAM_TIMEOUT = 10200; // milliseconds (leave a small buffer for rebroadcast to call back)

export class ArloCameraDevice extends ArloDeviceBase implements Camera, VideoCamera {
    private refreshTimeout?: NodeJS.Timeout;
    private originalMedia?: FFmpegInput;
    private isSnapshotEligible: boolean = true;
    private cachedSnapshot?: ArrayBuffer;
    private snapshotInProgress: boolean = false;
    private rtspUdpProxy?: RtspUdpProxy;

    // override
    onRegistrationUpdated(deviceRegistration: DeviceRegistration) {
        super.onRegistrationUpdated(deviceRegistration);
        this.isSnapshotEligible = true;
    }

    // override
    onStatusUpdated(deviceStatus: DeviceStatus) {
        super.onStatusUpdated(deviceStatus);
        this.isSnapshotEligible = true;
    }

    onMotionDetected() {
        if (this.isDeviceDisabled()) {
            return;
        }
        this.isSnapshotEligible = true;
        this.takePicture();
        super.onMotionDetected();
    }

    /** Camera */

    // implement
    async takePicture(option?: PictureOptions): Promise<MediaObject> {
        // skip all processing if the camera is disabled or we are in the process of taking a snapshot
        if (this.isDeviceDisabled()) {
            return { mimeType: '' };
        }

        while (this.snapshotInProgress) {
            await sleep(1000);
        }

        this.snapshotInProgress = true;
        this.console.debug(`${this.nativeId}: requesting snapshot`);

        // request a snapshot from the camera, if it's eligible
        if ((this.isSnapshotEligible || this.externallyPowered) && this.provider.baseStationApiClient != null && this.nativeId != null) {
            const response = await this.provider.baseStationApiClient.postSnapshotRequest(this.nativeId);
            if (response != null && response.result) {
                await sleep(500);
                this.console.debug(`${this.nativeId}: request successful; retrieving snapshot`);
                const buffer = await this.provider.baseStationApiClient.getSnapshot(this.nativeId);
                if (buffer) {
                    this.isSnapshotEligible = false;
                    this.cachedSnapshot = buffer;
                    this.snapshotInProgress = false;
                    return this.createMediaObject(buffer, 'image/jpeg');
                } else {
                    this.snapshotInProgress = false;
                    this.console.error(`${this.nativeId}: snapshot request failed`);
                }
            } else {
                this.snapshotInProgress = false;
                this.console.error(`${this.nativeId}: snapshot request failed`);
            }
        } else {
            this.snapshotInProgress = false;
            this.console.info(`${this.nativeId}: skipping snapshot because camera is on battery and motion hasn\'t been detected or status hasn\'t been sent recently`)
            return this.createMediaObject(this.cachedSnapshot, 'image/jpeg');
        }

        return { mimeType: 'image/example' };
    }

    // implement
    async getPictureOptions(): Promise<PictureOptions[]> {
        return [];
    }

    /** VideoCamera */

    // implement
    async getVideoStreamOptions(): Promise<ResponseMediaStreamOptions[]> {
        return [{
            id: 'channel0',
            name: 'Stream 1',
            container: 'rtsp',
            tool: 'scrypted',
            video: {
                codec: 'h264'
            },
            audio: this.isAudioDisabled() ? {} : {
                codec: 'aac'
            },
            allowBatteryPrebuffer: this.allowBatteryPrebuffer() && this.externallyPowered
        }];
    }

    // implement
    async getVideoStream(options?: ResponseMediaStreamOptions): Promise<MediaObject> {
        // skip all processing if the camera is disabled
        if (this.isDeviceDisabled()) {
            return { mimeType: '' };
        }

        // check if this is a refresh call
        if (options?.refreshAt) {
            if (!this.originalMedia) {
                throw new Error("no stream to refresh");
            }

            // get the previously constructed media object
            const newMedia = this.originalMedia;

            // set a new refresh date
            if (newMedia.mediaStreamOptions != null) {
                newMedia.mediaStreamOptions.refreshAt = Date.now() + REFRESH_TIMEOUT;
                newMedia.mediaStreamOptions.metadata = {
                    refreshAt: newMedia.mediaStreamOptions.refreshAt
                };
            }

            // reset the timeout and return the new media object
            this.resetStreamTimeout();
            return mediaManager.createMediaObject(newMedia, ScryptedMimeTypes.MediaStreamUrl);
        }

        // cameras tend to be unresponsive, particularly on battery, so send a status request to wake them up
        if (this.provider.baseStationApiClient != null && this.nativeId != null) {
            await this.provider.baseStationApiClient.postUserStreamActive(this.nativeId, true);
        }

        // reset the timeout and return the new media object
        this.resetStreamTimeout();

        this.originalMedia = {
            url: await this.buildRtspUrl(),
            mediaStreamOptions: {
                id: 'channel0',
                refreshAt: Date.now() + REFRESH_TIMEOUT,
                ...options,
            },
        };

        return mediaManager.createFFmpegMediaObject(this.originalMedia);
    }

    async buildRtspUrl(): Promise<string> {
        const preferredUrl = this.provider.getUseHostnames() ? this.deviceSummary.hostname : this.deviceSummary.ip;

        // TODO: use port 555 for 4k cameras
        if (this.sendRtcpRr()) {
            this.console.info('About to create proxy');
            this.rtspUdpProxy = new RtspUdpProxy(`rtsp://${preferredUrl}/live`);
            let proxyPort = await this.rtspUdpProxy.proxyUdpWithRtcp();
            return `rtsp://127.0.0.1:${proxyPort}`;
        } else {
            return `rtsp://${preferredUrl}/live`;
        }
    }

    resetStreamTimeout(): void {
        clearTimeout(this.refreshTimeout);
        this.refreshTimeout = setTimeout(() => {
            this.console.debug('stopping stream')
            this.rtspUdpProxy?.teardown();
            this.originalMedia = undefined;
            if (this.provider.baseStationApiClient != null && this.nativeId != null) {
                this.provider.baseStationApiClient.postUserStreamActive(this.nativeId, false);
            }
        }, STREAM_TIMEOUT);
    }

    /** Settings */

    // override
    async getSettings(): Promise<Setting[]> {
        let settings = await super.getSettings();
        return settings.concat([
            {
                key: 'allowBatteryPrebuffer',
                title: 'Allow Prebuffer When Charging',
                description: 'Enable this setting if you want to allow prebuffering when the camera is charging the battery.',
                type: 'boolean',
                value: (this.allowBatteryPrebuffer()).toString(),
            },
            {
                key: 'sendRtcpRr',
                title: 'Prevent Infinite Streaming on UDP',
                description: 'Enable this if your camera only supports UDP and you want to send RTCP Receiver Reports to it to avoid it streamining indefinitely. Not compatible with TCP.',
                type: 'boolean',
                value: (this.sendRtcpRr()).toString(),
            },
        ]);
    }

    allowBatteryPrebuffer(): boolean {
        return this.storage.getItem('allowBatteryPrebuffer') === 'true';
    }

    sendRtcpRr(): boolean {
        return this.storage.getItem('sendRtcpRr') === 'true';
    }
}