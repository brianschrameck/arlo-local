import { Battery, Camera, FFmpegInput, ScryptedInterface, MediaObject, MotionSensor, PictureOptions, ResponseMediaStreamOptions, ScryptedDeviceBase, Setting, Settings, SettingValue, VideoCamera } from '@scrypted/sdk';
import sdk from '@scrypted/sdk';
import { ArloCameraProvider } from './main';
import child_process from "child_process";
import { CameraSummary, CameraStatus } from './base-station-api-client';
import net from 'net';
import { sleep } from '@scrypted/common/src/sleep';
import { once } from 'events';
const { mediaManager } = sdk;

const REFRESH_TIMEOUT = 40000; // milliseconds (rebroadcast refreshes 30 seconds before the specified refreshAt time)
const GSTREAMER_TIMEOUT = 11000; // milliseconds (leave a 1 second buffer for rebroadcast to call back)
const DEFAULT_SENSOR_TIMEOUT = 30; // seconds
const COOLDOWN_TIMEOUT = 10000;

export class ArloCameraDevice extends ScryptedDeviceBase implements Battery, Camera, MotionSensor, Settings, VideoCamera {
    private motionTimeout?: NodeJS.Timeout;
    private gstreamerProcess?: child_process.ChildProcessWithoutNullStreams;
    private refreshTimeout?: NodeJS.Timeout;
    private originalMedia?: FFmpegInput;
    private gstreamerPort?: number;
    private gstreamerKillTime?: number;
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

        this.console.debug('Requesting snapshot.');

        if (this.isSnapshotEligible || this.isCameraPluggedIn()) {
            const response = await this.provider.baseStationApiClient.postSnapshotRequest(this.nativeId);
            if (response.result) {
                this.console.debug('Request successful. Retrieving snapshot.');
                const buffer = await this.provider.baseStationApiClient.getSnapshot(this.nativeId);
                this.isSnapshotEligible = false;
                this.cachedSnapshot = buffer;
                return this.createMediaObject(buffer, 'image/jpeg');
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
            video: {
                codec: 'h264'
            },
            audio: this.isAudioDisabled() ? null : {
                codec: 'opus'
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
            if (!this.gstreamerProcess || !this.originalMedia) {
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
            return mediaManager.createFFmpegMediaObject(newMedia);
        }

        // only startup gstreamer if we don't already have a process running; this could occur 
        if (this.gstreamerProcess) {
            this.resetStreamTimeout();
        }
        else {
            if (this.gstreamerKillTime ?? 0 + COOLDOWN_TIMEOUT > Date.now()) {
                const waitTime = this.gstreamerKillTime + COOLDOWN_TIMEOUT - Date.now();
                this.console.info(`waiting ${waitTime} for camera cooldown`)
                await sleep(waitTime);
            }

            // cameras tend to be unresponsive, particularly on battery, so send a status request to wake them up
            await this.provider.baseStationApiClient.postUserStreamActive(this.nativeId, true);

            // get a free port to use
            this.gstreamerPort = await this.getOpenPort();

            // build the gstreamer command
            let gstArgs: string[] = [];
            if (this.getGStreamerInput()) {
                gstArgs = this.getGStreamerInput().split(' ');
            } else {
                gstArgs.push(
                    // set up the RTSP source from the camera
                    'rtspsrc', `location=rtsp://${this.cameraSummary.ip}/live`, 'name=arlo', 'latency=1000', 'protocols=udp', 'timeout=30000000', 'drop-on-latency=true', 'do-rtsp-keep-alive=false', 'ntp-sync=true',
                    // parse the h264 video stream and push it to our sink
                    'arlo.', '!', 'rtph264depay', '!', 'mux.');
                if (!this.isAudioDisabled()) {
                    // parse the opus audio stream and push it to our sink
                    gstArgs.push('arlo.', '!', 'rtpopusdepay', '!', 'mux.');
                }
                // configure our mux to mpegts and UDP sink to FFMPEG
                gstArgs.push('mpegtsmux', 'name=mux', '!', 'udpsink', 'host=127.0.0.1', `port=${this.gstreamerPort}`);
            }

            // launch the gstreamer command to start the stream
            this.console.info('starting GStreamer pipeline; command: gst-launch-1.0 ' + gstArgs.join(' '));
            this.gstreamerProcess = child_process.spawn('gst-launch-1.0', gstArgs, { env: { GST_DEBUG: this.isGstDebug() ? '5' : '1' } });
            this.gstreamerProcess.stdout.on('data', data => this.console.log(data.toString()));
            this.gstreamerProcess.stderr.on('data', data => this.console.log(data.toString()));
            this.gstreamerProcess.on('close', () => { this.killGStreamer() });

            await once(this.gstreamerProcess, 'spawn');
            this.gstreamerProcess.once('exit', () => {
                this.killGStreamer();
                return;
            });
        }

        // build the ffmpeg command
        let ffmpegArgs: string[] = [];
        if (this.getFfmpegInput()) {
            ffmpegArgs = this.getFfmpegInput().split(' ');
        } else {
            ffmpegArgs = ['-timeout', '1000000', '-f', 'mpegts', '-i', `udp://127.0.0.1:${this.gstreamerPort}`];
        }

        // return the ffmpeg input that should contain the output of the gstreamer pipeline
        this.originalMedia = {
            url: undefined,
            inputArguments: ffmpegArgs,
            mediaStreamOptions: {
                id: options?.id ?? 'channel0',
                refreshAt: Date.now() + REFRESH_TIMEOUT,
                ...options
            },
        };

        // reset the timeout and return the new media object
        this.resetStreamTimeout();
        return mediaManager.createFFmpegMediaObject(this.originalMedia);
    }

    resetStreamTimeout() {
        console.debug('starting/refreshing stream');
        clearTimeout(this.refreshTimeout);
        this.refreshTimeout = setTimeout(() => this.killGStreamer(), GSTREAMER_TIMEOUT);
    }

    async killGStreamer() {
        if (this.gstreamerProcess) {
            this.log.d('ending gstreamer process');
            this.gstreamerProcess.kill();
            this.gstreamerProcess = undefined;
            this.gstreamerKillTime = Date.now();
            this.gstreamerPort = undefined;
        }
        await this.provider.baseStationApiClient.postUserStreamActive(this.nativeId, false);
    }

    /** Settings */

    // implement
    async getSettings(): Promise<Setting[]> {
        this.console.info('getting settings');
        return [
            {
                key: 'gStreamerInput',
                title: 'GStreamer Input Stream Override',
                description: 'Optional override of GStreamer input arguments passed to the command line gst-launch-1.0 tool.',
                placeholder: 'rtspsrc location=rtsp://192.168.1.100/live ...',
                value: this.getGStreamerInput(),
            },
            {
                key: 'ffmpegInput',
                title: 'FFmpeg Input Stream Override',
                description: 'Optional override of FFmpeg input arguments passed to the media manager.',
                placeholder: '-f mpegts -i udp://127.0.0.1:54321',
                value: this.getFfmpegInput(),
            },
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
                key: 'isGstDebug',
                title: 'GStreamer Debug',
                description: 'Enable this setting if you want additional debug output for the GStreamer pipeline.',
                type: 'boolean',
                value: (this.isGstDebug()).toString(),
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

    getGStreamerInput(): string {
        return this.storage.getItem('gStreamerInput');
    }

    getFfmpegInput(): string {
        return this.storage.getItem('ffmpegInput');
    }

    getMotionSensorTimeout() {
        return parseInt(this.storage.getItem('motionSensorTimeout')) || DEFAULT_SENSOR_TIMEOUT;
    }

    isAudioDisabled() {
        return this.storage.getItem('isAudioDisabled') === 'true' || this.cameraStatus.UpdateSystemModelNumber === 'VMC3030';
    }

    isGstDebug() {
        return this.storage.getItem('isGstDebug') === 'true';
    }

    isCameraDisabled() {
        return this.storage.getItem('isCameraDisabled') === 'true';
    }

    private isPortOpen = async (port: number): Promise<boolean> => {
        return new Promise((resolve) => {
            let s = net.createServer();
            s.once('error', () => {
                s.close();
                resolve(false);
            });
            s.once('listening', () => {
                s.close(() => { resolve(true); });
                setImmediate(() => { s.emit('close') });
            });
            s.listen(port);
        });
    }

    private getOpenPort = async (attempts: number = 10) => {
        let openPort: number = null;
        let attemptNum = 0;

        this.console.debug('trying to find a free port');
        while (attemptNum < attempts && !openPort) {
            const port = Math.round(Math.random() * 30000 + 30000);
            if (await this.isPortOpen(port)) {
                this.console.debug(`found free port: ${port}`);
                openPort = port;
            }
            attemptNum++;
        }

        return openPort;
    };
}