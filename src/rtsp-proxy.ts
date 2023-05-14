import net, { AddressInfo } from 'net';
import { closeQuiet, createBindUdp, listenZero } from '../../../common/src/listen-cluster';
import { RtspClient, RtspClientUdpSetupOptions, RtspServer } from '../../../common/src/rtsp-server';
import { RtcpSession } from "./rtcp-session";

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

            // create an RTSP server using the SDP
            this.rtspServer = new RtspServer(serverSocket, sdp, true);
            const setupResponse = await this.rtspServer.handlePlayback();
            if (setupResponse !== 'play') {
                serverSocket.destroy();
                this.rtspClient.client.destroy();
                return;
            }
            console.log('playback handled');

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
                const setupResult = await this.rtspClient.setup(setup);
                let rtcpDgram = await this.setupRtcpDgram(setup);

                if (setupResult.headers.transport) {
                    const match = setupResult.headers.transport.match(/.*?server_port=([0-9]+)-([0-9]+)/);
                    if (match) {
                        const [_, rtp, rtcp] = match;
                        console.log(`rtp ${rtp} rtcp ${rtcp}`);
                        const rtpcPublishPort = parseInt(rtcp);
                        // have seen some servers return a server_port 0. should watch for bad data in any case.
                        if (rtpcPublishPort) {
                            const { hostname } = new URL(this.rtspClientUrl);
                            const punch = Buffer.alloc(1);
                            rtcpDgram.send(punch, rtpcPublishPort, hostname);
                            rtcpDgram.on('message', async data => {
                                rtcpSession.onRtcpSr(data);
                                try {
                                    const rr = rtcpSession.buildReceiverReport();    
                                    rtcpDgram.send(rr.serialize(), rtpcPublishPort, hostname);
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
                    closeQuiet(rtcpDgram);
                });
            }

            this.server.on('close', () => {
                console.log('closing rtcp proxy');
                serverSocket.destroy();
                this.rtspClient.client.destroy();
            });

            await this.rtspClient.play();
            await this.rtspClient.readLoop();
        });

        await listenZero(this.server);
        return (this.server.address() as AddressInfo).port;
    }

    async setupRtcpDgram(setup: RtspClientUdpSetupOptions) {
        const rtcpListenPort = setup.dgram.address().port + 1;
        return (await createBindUdp(rtcpListenPort)).server;
    }

    async teardown() {
        console.log('tearing down');
        this.rtspClient?.safeTeardown();
        this.rtspServer?.teardown('', {});
        this.server?.close();
    }
}