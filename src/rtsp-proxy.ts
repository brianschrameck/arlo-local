import net, { AddressInfo } from 'net';
import { closeQuiet, createBindUdp, listenZero } from '@scrypted/common/src/listen-cluster';
import { RtspClient, RtspClientUdpSetupOptions, RtspServer } from '@scrypted/common/src/rtsp-server';
import { RtcpSession } from './rtcp-session';
import { Socket } from 'dgram';

export class RtspUdpProxy {
    private rtspClient: RtspClient;
    private rtspServer: RtspServer;
    private server: net.Server;

    constructor(private rtspClientUrl: string) {
        this.rtspClientUrl = rtspClientUrl;
    }

    async proxyUdpWithRtcp(): Promise<Number> {
        this.server = net.createServer(async serverSocket => {
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

            // go through each track and set up the RTCP session for it
            for (const track of Object.keys(this.rtspServer.setupTracks)) {
                console.log('setting up track')
                const rtcpSession = new RtcpSession();
                const setupTrack = this.rtspServer.setupTracks[track];
                const setup: RtspClientUdpSetupOptions = {
                    path: setupTrack.control,
                    type: 'udp',
                    onRtp: (_, rtp) => {
                        rtcpSession.onRtp(rtp)
                        this.rtspServer.sendTrack(setupTrack.control, rtp, false);
                    },
                };

                // set up the RTSP client; RTSP handshake
                const setupResult = await this.rtspClient.setup(setup);

                // set up the RTCP client
                let rtcpDgram = await this.setupRtcpDgram(setup);

                // ensure we parsed the handshake correctly
                if (rtcpDgram != null && setupResult.headers.transport) {
                    // exctract the RTSP and RTCP server ports
                    const match = setupResult.headers.transport.match(/.*?server_port=([0-9]+)-([0-9]+)/);
                    if (match) {
                        const [_, rtp, rtcp] = match;
                        console.log(`rtp ${rtp} rtcp ${rtcp}`);
                        const rtpcPublishPort = parseInt(rtcp);
                        // have seen some servers return a server_port 0. should watch for bad data in any case.
                        if (rtpcPublishPort) {
                            // ensure we can contact the RTCP port on the server
                            const { hostname } = new URL(this.rtspClientUrl);
                            const punch = Buffer.alloc(1);
                            rtcpDgram.send(punch, rtpcPublishPort, hostname);

                            // when we receive an RTCP Sender Report...
                            rtcpDgram.on('message', async data => {
                                // parse it
                                rtcpSession.onRtcpSr(data);
                                try {
                                    // build and send an RTCP Receiver Report
                                    const rr = rtcpSession.buildReceiverReport();
                                    if (rr != null && rtcpDgram != null) {
                                        rtcpDgram.send(rr.serialize(), rtpcPublishPort, hostname);
                                    }
                                } catch (error) {
                                    // Do nothing for now.
                                    console.error('Error creating receiver report');
                                }
                            });
                        }
                    }
                }

                this.server.on('close', () => {
                    console.log('closing rtcp dgram');
                    if (rtcpDgram) {
                        closeQuiet(rtcpDgram);
                    }
                });
            }

            this.server.on('close', () => {
                console.log('closing rtcp proxy');
                serverSocket.destroy();
            });

            // time to start the stream and read it
            await this.rtspClient.play();
            await this.rtspClient.readLoop();
        });

        // listen on a random port
        await listenZero(this.server);

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

    async teardown() {
        console.log('tearing down');
        this.rtspClient?.safeTeardown();
        this.rtspServer?.teardown('', {});
        this.server?.close();
    }
}