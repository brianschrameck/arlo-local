import { Battery, Camera, FFmpegInput, MediaObject, MotionSensor, PictureOptions, ResponseMediaStreamOptions, ScryptedDeviceBase, Setting, Settings, SettingValue, VideoCamera, ScryptedMimeTypes } from '@scrypted/sdk';
import sdk from '@scrypted/sdk';
import { ArloCameraProvider } from './main';

import { CameraSummary, CameraStatus } from './base-station-api-client';
const { mediaManager } = sdk;

const REFRESH_TIMEOUT = 40000; // milliseconds (rebroadcast refreshes 30 seconds before the specified refreshAt time)
const COOLDOWN_TIMEOUT = 11000; // milliseconds (leave a 1 second buffer for rebroadcast to call back)
const DEFAULT_SENSOR_TIMEOUT = 30; // seconds

export class ArloCameraDevice extends ScryptedDeviceBase implements Battery, Camera, MotionSensor, Settings, VideoCamera {
    private motionTimeout?: NodeJS.Timeout;
    private refreshTimeout?: NodeJS.Timeout;
    private originalMedia?: FFmpegInput;
    private isSnapshotEligible: boolean = false;
    private cachedSnapshot?: ArrayBuffer;

    cameraSummary: CameraSummary;
    cameraStatus: CameraStatus;

    constructor(public provider: ArloCameraProvider, nativeId: string, cameraSummary: CameraSummary, cameraStatus: CameraStatus) {
        super(nativeId);
        this.cameraSummary = cameraSummary;
        this.cameraStatus = cameraStatus;
        this.batteryLevel = cameraStatus.BatPercent;
    }

    onStatusUpdated(cameraStatus: CameraStatus) {
        this.cameraStatus = cameraStatus;
        this.batteryLevel = this.cameraStatus.BatPercent;
        this.provider.updateDevice(this.nativeId, this.cameraStatus);
        this.isSnapshotEligible = true;
    }

    onMotionDetected() {
        this.isSnapshotEligible = true;
        this.takePicture();
        this.motionDetected = true;
        this.resetMotionTimeout();
    }

    resetMotionTimeout() {
        clearTimeout(this.motionTimeout);
        this.motionTimeout = setTimeout(() => {
            this.motionDetected = false;
        }, this.getMotionSensorTimeout() * 1000);
    }

    /** Camera */

    // implement
    async takePicture(option?: PictureOptions): Promise<MediaObject> {
        // skip all processing if the camera is disabled
        if (this.isCameraDisabled()) {
            return;
        }

        this.console.debug(`Requesting snapshot for ${this.nativeId}.`);

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
        return ['QuickCharger', 'Regular'].includes(this.cameraStatus.ChargerTech);
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
        if (this.isCameraDisabled()) {
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
            url: `rtsp://${this.cameraSummary.ip}/live`,
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
        }, COOLDOWN_TIMEOUT);
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
                description: 'Enable this setting if the camera does not have audio or to mute audio.',
                type: 'boolean',
                value: (this.isAudioDisabled()).toString(),
            },
            {
                key: 'isCameraDisabled',
                title: 'Disable Camera',
                description: 'Enable this setting if you want to disable this camera. All video processing will be disabled.',
                type: 'boolean',
                value: (this.isCameraDisabled()).toString(),
            }
        ];
    }

    // implement
    async putSetting(key: string, value: SettingValue) {
        this.storage.setItem(key, value.toString());
    }

    getMotionSensorTimeout() {
        return parseInt(this.storage.getItem('motionSensorTimeout')) || DEFAULT_SENSOR_TIMEOUT;
    }

    isAudioDisabled() {
        return this.storage.getItem('isAudioDisabled') === 'true' || this.cameraStatus.UpdateSystemModelNumber === 'VMC3030';
    }

    isCameraDisabled() {
        return this.storage.getItem('isCameraDisabled') === 'true';
    }
}