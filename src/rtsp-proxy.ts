import net from 'net';
import { closeQuiet, createBindUdp, listenZero } from '../../../common/src/listen-cluster';
import { RtspClient, RtspClientUdpSetupOptions, RtspServer, RtspServerResponse } from '../../../common/src/rtsp-server';
import { RtcpSession } from "./rtcp-session";
import { Socket } from 'dgram';

let rtspClient: RtspClient;
let rtspServer: RtspServer;
let rtcpDgram: Socket;

async function proxyUdpWithRtcp(rtspClientUrl: string): Promise<net.Server> {
    const server = net.createServer(async serverSocket => {
        rtspClient = new RtspClient(rtspClientUrl);
        await rtspClient.options();
        const describeResponse = await rtspClient.describe();
        const sdp = describeResponse.body.toString();
        const rtspServer = new RtspServer(serverSocket, sdp, true);
        const setupResponse = await rtspServer.handlePlayback();
        if (setupResponse !== 'play') {
            serverSocket.destroy();
            rtspClient.client.destroy();
            return;
        }
        console.log('playback handled');

        for (const track of Object.keys(rtspServer.setupTracks)) {
            const rtcpSession = new RtcpSession();
            const setupTrack = rtspServer.setupTracks[track];
            const setup: RtspClientUdpSetupOptions = {
                path: setupTrack.control,
                type: 'udp',
                onRtp: (_, rtp) => {
                    rtcpSession.onRtp(rtp)
                    rtspServer.sendTrack(setupTrack.control, rtp, false);
                },
            };
            const setupResult = await rtspClient.setup(setup);
            rtcpDgram = await setupRtcpDgram(setup);

            if (setupResult.headers.transport) {
                const match = setupResult.headers.transport.match(/.*?server_port=([0-9]+)-([0-9]+)/);
                if (match) {
                    const [_, rtp, rtcp] = match;
                    console.log(`rtp ${rtp} rtcp ${rtcp}`);
                    const rtpcPublishPort = parseInt(rtcp);
                    // have seen some servers return a server_port 0. should watch for bad data in any case.
                    if (rtpcPublishPort) {
                        const { hostname } = new URL(rtspClientUrl);
                        const punch = Buffer.alloc(1);
                        rtcpDgram.send(punch, rtpcPublishPort, hostname);
                        rtcpDgram.on('message', async data => {
                            rtcpSession.onRtcpSr(data);
                            const rr = rtcpSession.buildReceiverReport();
                            rtcpDgram.send(rr, rtpcPublishPort, hostname);
                        });
                    }
                }
            }

            server.on('close', () => {
                console.log('closing rtcp dgram');
                closeQuiet(rtcpDgram);
            });
        }

        server.on('close', () => {
            console.log('closing rtcp proxy');
            serverSocket.destroy();
            rtspClient.client.destroy();
        });

        await rtspClient.play();
        await rtspClient.readLoop();
    });

    await listenZero(server);
    return server;
}

async function setupRtcpDgram(setup: RtspClientUdpSetupOptions) {
    const rtcpListenPort = setup.dgram.address().port + 1;
    return (await createBindUdp(rtcpListenPort)).server;
}

export async function teardown() {
    rtspClient?.safeTeardown();
    rtspServer?.teardown('', {});
    rtcpDgram.close();
}

export default proxyUdpWithRtcp;