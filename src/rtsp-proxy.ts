import net, { AddressInfo } from 'net';
import { closeQuiet, createBindUdp, listenZero } from '@scrypted/common/src/listen-cluster';
import { RtspClient, RtspClientUdpSetupOptions, RtspServer } from '@scrypted/common/src/rtsp-server';
import { parseSdp } from '@scrypted/common/src/sdp-utils';
import { RtcpSession } from './rtcp-session';
import { Socket } from 'dgram';

export class RtspUdpProxy {
    private rtspClient?: RtspClient;
    private rtspServer?: RtspServer;
    private server?: net.Server;

    constructor(private rtspClientUrl: string) {
        this.rtspClientUrl = rtspClientUrl;
    }

    async proxyUdpWithRtcp(): Promise<Number> {
        this.server = net.createServer(async serverSocket => {
            serverSocket.on('error', error => {
                if ((error as NodeJS.ErrnoException).code !== 'EPIPE') {
                    console.error('RTSP proxy client socket error', error);
                }
            });
            serverSocket.on('close', () => {
                this.rtspClient?.safeTeardown();
                if (this.server?.listening) {
                    this.server.close();
                }
            });

            // create an RTSP client to read from the camera
            this.rtspClient = new RtspClient(this.rtspClientUrl);

            // call OPTIONS to get the SDP; we just ignore the result, but some cameras might require this first
            await this.rtspClient.options();

            // call DESCRIBE to get the SDP
            const describeResponse = await this.rtspClient.describe();
            const sdp = describeResponse.body.toString();

            // create an RTSP server using the SDP and ensure we get a PLAY response
            this.rtspServer = new RtspServer(serverSocket, sdp, true);
            const setupResponse = await this.rtspServer.handlePlayback();
            if (setupResponse !== 'play') {
                serverSocket.destroy();
                this.rtspClient.client.destroy();
                return;
            }
            console.log('playback handled');

            // SDP media sections contain the RTP clock rate for each track.
            // H264 uses 90 kHz while audio codecs commonly use 8, 16, 48 kHz,
            // or another rate declared by a=rtpmap.
            const parsedSdp = parseSdp(sdp);

            // go through each track and set up the RTCP session for it
            for (const track of Object.keys(this.rtspServer.setupTracks)) {
                console.log('setting up track')
                const setupTrack = this.rtspServer.setupTracks[track];
                const clockRate = this.getTrackClockRate(parsedSdp.msections, setupTrack.control);
                const rtcpSessionForTrack = new RtcpSession(clockRate);
                const setup: RtspClientUdpSetupOptions = {
                    path: setupTrack.control,
                    type: 'udp',
                    onRtp: (_, rtp) => {
                        rtcpSessionForTrack.onRtp(rtp);

                        if (this.rtspServer && !serverSocket.destroyed) {
                            this.rtspServer.sendTrack(setupTrack.control, rtp, false);
                        } else if (!serverSocket.destroyed) {
                            console.warn('rtspServer is null, cannot send track');
                        }
                    },
                };

                // set up the RTSP client; RTSP handshake
                const setupResult = await this.rtspClient.setup(setup);

                // set up the RTCP client
                let rtcpDgram = await this.setupRtcpDgram(setup);

                // ensure we parsed the handshake correctly
                if (rtcpDgram != null && setupResult.headers.transport) {
                    // exctract the RTSP and RTCP server ports
                    const match = setupResult.headers.transport.match(/(?:^|;)\s*server_port=([0-9]+)-([0-9]+)/i);
                    if (match) {
                        const [_, rtp, rtcp] = match;
                        console.log(`rtp ${rtp} rtcp ${rtcp}`);
                        const rtpcPublishPort = parseInt(rtcp);
                        // have seen some servers return a server_port 0. should watch for bad data in any case.
                        if (rtpcPublishPort) {
                            // ensure we can contact the RTCP port on the server
                            const { hostname } = new URL(this.rtspClientUrl);
                            const punch = new Uint8Array(1);
                            rtcpDgram.send(punch, rtpcPublishPort, hostname);

                            // when we receive an RTCP Sender Report...
                            rtcpDgram.on('message', async data => {
                                // parse it
                                rtcpSessionForTrack.onRtcpSr(data);
                                try {
                                    // build and send an RTCP Receiver Report
                                    const rr = rtcpSessionForTrack.buildReceiverReport();
                                    if (rr != null && rtcpDgram != null) {
                                        rtcpDgram.send(Uint8Array.from(rr.serialize()), rtpcPublishPort, hostname);
                                    } else {
                                        console.warn('no receiver report to send');
                                    }
                                } catch (error) {
                                    // Do nothing for now.
                                    console.error('Error creating receiver report', error);
                                }
                            });
                        }
                    }
                }

                this.server?.on('close', () => {
                    console.log('closing rtcp dgram');
                    if (rtcpDgram) {
                        closeQuiet(rtcpDgram);
                    }
                });
            }

            this.server?.on('close', () => {
                console.log('closing rtcp proxy');
                serverSocket.destroy();
            });

            // time to start the stream and read it
            await this.rtspClient.play();
            await this.rtspClient.readLoop();
        });

        // listen on a random port
        (await listenZero(this.server, '127.0.0.1'));

        // return the port that this server is listening on
        return (this.server.address() as AddressInfo).port;
    }

    async setupRtcpDgram(setup: RtspClientUdpSetupOptions): Promise<Socket | null> {
        if (setup.dgram) {
            const rtcpListenPort = setup.dgram?.address().port + 1;
            return (await createBindUdp(rtcpListenPort)).server;
        }
        return null;
    }

    private getTrackClockRate(
        msections: ReturnType<typeof parseSdp>['msections'],
        trackControl: string,
    ): number {
        const msection = msections.find(section =>
            section.control === trackControl
            || (section.control != null && trackControl.endsWith(section.control)));

        // SDP rtpmap fields are authoritative when present.
        if (msection?.rtpmap?.clock) {
            console.debug(`Found rtpmap clock for ${msection?.codec} track ${trackControl}: ${msection.rtpmap.clock}`);
            return msection.rtpmap.clock;
        }

        // Keep standard codec fallbacks for SDP variants that omit rtpmap clock.
        if (msection?.codec === 'opus') {
            console.debug(`Found opus codec for track ${trackControl}, using 48000 Hz clock`);
            return 48000;
        }
        if (msection?.codec === 'h264' || msection?.codec === 'h265') {
            console.debug(`Found ${msection.codec} codec for track ${trackControl}, using 90000 Hz clock`);
            return 90000;
        }
        if (msection?.codec === 'pcm_mulaw' || msection?.codec === 'pcm_alaw') {
            console.debug(`Found ${msection.codec} codec for track ${trackControl}, using 8000 Hz clock`);
            return 8000;
        }

        // RTP timestamp units are codec-specific; 90 kHz is the video default.
        console.debug(`Using default clock for track ${trackControl}, using 90000 Hz clock`);
        return 90000;
    }

    async teardown() {
        console.log('tearing down');
        this.rtspClient?.safeTeardown();
        if (this.rtspServer && !this.rtspServer.client.destroyed) {
            this.rtspServer.teardown('', {});
        }
        if (this.server?.listening) {
            this.server.close();
        }
    }
}