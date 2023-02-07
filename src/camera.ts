import { Battery, Camera, FFmpegInput, MediaObject, MotionSensor, PictureOptions, ResponseMediaStreamOptions, Settings, VideoCamera, ScryptedMimeTypes, RequestMediaStreamOptions } from '@scrypted/sdk';
import sdk from '@scrypted/sdk';

import { CameraStatus, DeviceStatus } from './base-station-api-client';
import { ArloDeviceBase } from './arlo-device-base';
const { systemManager, mediaManager } = sdk;

const REFRESH_TIMEOUT = 40000; // milliseconds (rebroadcast refreshes 30 seconds before the specified refreshAt time)
const STREAM_TIMEOUT = 10200; // milliseconds (leave a small buffer for rebroadcast to call back)

export class ArloCameraDevice extends ArloDeviceBase implements Battery, Camera, MotionSensor, Settings, VideoCamera {
    private refreshTimeout?: NodeJS.Timeout;
    private originalMedia?: FFmpegInput;
    private isSnapshotEligible: boolean = true;
    private cachedSnapshot?: ArrayBuffer;

    onStatusUpdated(deviceStatus: DeviceStatus) {
        this.deviceStatus = deviceStatus;
        this.batteryLevel = this.deviceStatus.BatPercent;
        this.provider.updateDeviceStatus(this.nativeId, this.deviceStatus);
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
        // skip all processing if the camera is disabled
        if (this.isDeviceDisabled()) {
            return;
        }

        this.console.debug(`Requesting snapshot for ${this.nativeId}.`);

        // if this stream is prebuffered, its safe to use the prebuffer to generate an image
        try {
            const realDevice = systemManager.getDeviceById<VideoCamera>(this.id);
            const msos = await realDevice.getVideoStreamOptions();
            let prebufferChannel = msos?.find(mso => mso.prebuffer);
            if (prebufferChannel) {
                prebufferChannel = prebufferChannel || {
                    id: undefined,
                };

                const request = prebufferChannel as RequestMediaStreamOptions;
                // specify the prebuffer based on the usage. events shouldn't request
                // lengthy prebuffers as it may not contain the image it needs.
                request.prebuffer = 500;
                request.refresh = false;
                this.console.log('snapshotting active prebuffer');
                const vs = await realDevice.getVideoStream(request);
                const buffer = await mediaManager.convertMediaObjectToBuffer(vs, 'image/jpeg');
                return this.createMediaObject(buffer, 'image/jpeg');
            }
        }
        catch (e) {
        }

        // otherwise, request a snapshot from the camera, if it's eligible
        if (this.isSnapshotEligible || this.isCameraPluggedIn()) {
            const response = await this.provider.baseStationApiClient.postSnapshotRequest(this.nativeId);
            if (response.result) {
                this.console.debug(`Request successful. Retrieving snapshot for ${this.nativeId}.`);
                const buffer = await this.provider.baseStationApiClient.getSnapshot(this.nativeId);
                if (buffer) {
                    this.isSnapshotEligible = false;
                    this.cachedSnapshot = buffer;
                    return this.createMediaObject(buffer, 'image/jpeg');
                }
            } else {
                this.console.error('Snapshot request failed.');
            }
        } else {
            this.console.info('Skipping snapshot because camera is on battery and motion hasn\'t been detected or status hasn\'t been sent recently.')
            return this.createMediaObject(this.cachedSnapshot, 'image/jpeg');
        }
    }

    private isCameraPluggedIn(): boolean {
        return ['QuickCharger', 'Regular'].includes((this.deviceStatus as CameraStatus).ChargerTech);
    }

    // implement
    async getPictureOptions(): Promise<PictureOptions[]> {
        return;
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
            audio: this.isAudioDisabled() ? null : {
                codec: 'aac'
            },
        }];
    }

    // implement
    async getVideoStream(options?: ResponseMediaStreamOptions): Promise<MediaObject> {
        // skip all processing if the camera is disabled
        if (this.isDeviceDisabled()) {
            return;
        }

        // check if this is a refresh call
        if (options?.refreshAt) {
            if (!this.originalMedia) {
                throw new Error("no stream to refresh");
            }

            // get the previously constructed media object
            const newMedia = this.originalMedia;

            // set a new refresh date
            newMedia.mediaStreamOptions.refreshAt = Date.now() + REFRESH_TIMEOUT;
            newMedia.mediaStreamOptions.metadata = {
                refreshAt: newMedia.mediaStreamOptions.refreshAt
            };

            // reset the timeout and return the new media object
            this.resetStreamTimeout();
            return mediaManager.createMediaObject(newMedia, ScryptedMimeTypes.MediaStreamUrl);
        }

        // cameras tend to be unresponsive, particularly on battery, so send a status request to wake them up
        await this.provider.baseStationApiClient.postUserStreamActive(this.nativeId, true);

        // reset the timeout and return the new media object
        this.resetStreamTimeout();

        this.originalMedia = {
            url: `rtsp://${this.deviceSummary.ip}/live`,
            mediaStreamOptions: {
                id: 'channel0',
                refreshAt: Date.now() + REFRESH_TIMEOUT,
                ...options,
            },
        };

        return mediaManager.createFFmpegMediaObject(this.originalMedia);
    }

    resetStreamTimeout() {
        clearTimeout(this.refreshTimeout);
        this.refreshTimeout = setTimeout(() => {
            this.console.debug('stopping stream')
            this.provider.baseStationApiClient.postUserStreamActive(this.nativeId, false);
            this.originalMedia = undefined;
        }, STREAM_TIMEOUT);
    }
}