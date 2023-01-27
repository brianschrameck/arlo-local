import { Battery, Camera, FFmpegInput, MediaObject, MotionSensor, PictureOptions, RequestMediaStreamOptions, ResponseMediaStreamOptions, ScryptedDeviceBase, Setting, Settings, SettingValue, VideoCamera } from '@scrypted/sdk';
import sdk from '@scrypted/sdk';
import { ArloCameraProvider } from './main';
import child_process from "child_process";
import { BaseStationCameraSummary, BaseStationCameraStatus } from './base-station-api-client';
import net from 'net';
const { mediaManager } = sdk;

const GSTREAMER_TIMEOUT = 40000; // milliseconds (refresh clock is 30 seconds behind for some reason, this should give about a 10 second refreshinterval)
const DEFAULT_SENSOR_TIMEOUT = 30; // seconds

export class ArloCameraDevice extends ScryptedDeviceBase implements Battery, Camera, MotionSensor, Settings, VideoCamera {
    private motionTimeout?: NodeJS.Timeout;
    private gstreamerProcess?: child_process.ChildProcessWithoutNullStreams;
    private refreshTimeout?: NodeJS.Timeout;
    private originalMedia?: FFmpegInput;

    cameraSummary: BaseStationCameraSummary;
    cameraStatus: BaseStationCameraStatus;

    constructor(public provider: ArloCameraProvider, nativeId: string, cameraSummary: BaseStationCameraSummary, cameraStatus: BaseStationCameraStatus) {
        super(nativeId);
        this.cameraSummary = cameraSummary;
        this.cameraStatus = cameraStatus;
        this.batteryLevel = cameraStatus.BatPercent;
    }

    onStatusUpdate(cameraStatus: BaseStationCameraStatus) {
        this.cameraStatus = cameraStatus;
        this.batteryLevel = cameraStatus.BatPercent;
    }

    onMotionDetected() {
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
        return;
    }

    // implement
    async getPictureOptions(): Promise<PictureOptions[]> {
        return;
    }

    async takePictureThrottled(option?: PictureOptions): Promise<MediaObject> {
        // TODO: implement this
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
        // check if this is a refresh call
        if (options?.refreshAt) {
            if (!this.gstreamerProcess || !this.originalMedia) {
                throw new Error("no stream to refresh");
            }

            // get the previously constructed media object
            const newMedia = this.originalMedia;

            // set a new refresh date
            newMedia.mediaStreamOptions.refreshAt = Date.now() + GSTREAMER_TIMEOUT;
            newMedia.mediaStreamOptions.metadata = {
                refreshAt: newMedia.mediaStreamOptions.refreshAt
            };

            // reset the timeout and return the new media object
            this.resetStreamTimeout();
            return mediaManager.createFFmpegMediaObject(newMedia);
        }

        // get a free port to use
        const gstreamerPort = await this.getOpenPort();
        //const gstreamerPort = Math.round(Math.random() * 30000 + 30000);

        // build the gstreamer command
        let gstArgs: string[] = [];
        if (this.getGStreamerInput()) {
            gstArgs = this.getGStreamerInput().split(' ');
        } else {
            gstArgs.push(
                // set up the RTSP source from the camera
                'rtspsrc', `location=rtsp://${this.cameraSummary.ip}/live`, 'name=arlo', 'latency=200',
                // parse the h264 video stream and push it to our sink
                'arlo.', '!', 'rtph264depay', '!', 'queue', '!', 'mux.');
            if (!this.isAudioDisabled()) {
                // parse the opus audio stream and push it to our sink
                gstArgs.push('arlo.', '!', 'rtpopusdepay', '!', 'queue', '!', 'mux.');
            }
            // configure our mux to mpegts and TCP sink to FFMPEG
            gstArgs.push('mpegtsmux', 'name=mux', '!', 'tcpserversink', 'host=127.0.0.1', `port=${gstreamerPort}`, 'timeout=10000000000'/*ns*/);
        }

        // launch the gstreamer command to start the stream
        this.console.info('starting GStreamer pipeline; command: gst-launch-1.0 ' + gstArgs.join(' '));
        this.gstreamerProcess = child_process.spawn('gst-launch-1.0', gstArgs, { env: { GST_DEBUG: this.isGstDebugEnabled() ? '5' : '1' } });
        this.gstreamerProcess.stdout.on('data', data => this.console.log(data.toString()));
        this.gstreamerProcess.stderr.on('data', data => this.console.log(data.toString()));

        // build the ffmpeg command
        let ffmpegArgs: string[] = [];
        if (this.getFfmpegInput()) {
            ffmpegArgs = this.getFfmpegInput().split(' ');
        } else {
            ffmpegArgs = ['-timeout', '1000000', '-f', 'mpegts', '-i', `tcp://127.0.0.1:${gstreamerPort}`];
        }

        // return the ffmpeg input that should contain the output of the gstreamer pipeline
        this.originalMedia = {
            url: undefined,
            inputArguments: ffmpegArgs,
            mediaStreamOptions: {
                id: options?.id ?? 'channel0',
                refreshAt: Date.now() + GSTREAMER_TIMEOUT,
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

    killGStreamer() {
        if (this.gstreamerProcess) {
            this.log.d('ending gstreamer process');
            this.gstreamerProcess.kill();
            this.gstreamerProcess = undefined;
        }
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
                key: 'noAudio',
                title: 'No Audio',
                description: 'Enable this setting if the camera does not have audio or to mute audio.',
                type: 'boolean',
                value: (this.isAudioDisabled()).toString(),
            },
            {
                key: 'gstDebug',
                title: 'GStreamer Debug',
                description: 'Enable this setting if you want additional debug output for the GStreamer pipeline.',
                type: 'boolean',
                value: (this.isGstDebugEnabled()).toString(),
            },
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
        return this.storage.getItem('noAudio') === 'true' || this.cameraStatus.UpdateSystemModelNumber === 'VMC3030';
    }

    isGstDebugEnabled() {
        return this.storage.getItem('gstDebug') === 'true';
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