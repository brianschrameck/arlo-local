import net from 'net';
import { closeQuiet, createBindUdp, listenZero } from '../../../common/src/listen-cluster';
import { RtspClient, RtspClientUdpSetupOptions, RtspServer, RtspServerResponse } from '../../../common/src/rtsp-server';
import { RtcpSession } from "./rtcp-session";

async function proxyUdpWithRtcp(rtspClientUrl: string): Promise<{ server: net.Server, port: number }> {
    const server = net.createServer(async serverSocket => {
        const client = new RtspClient(rtspClientUrl);
        await client.options();
        const describeResponse = await client.describe();
        const sdp = describeResponse.body.toString();
        const rtspServer = new RtspServer(serverSocket, sdp, true);
        const setupResponse = await rtspServer.handlePlayback();
        if (setupResponse !== 'play') {
            serverSocket.destroy();
            client.client.destroy();
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
            const setupResult = await client.setup(setup);


            c function setupRtcp(setup: RtspClientUdpSetupOptions, response: RtspServerResponse) {
                if (response.headers.transport) {
                    const match = response.headers.transport.match(/.*?server_port=([0-9]+)-([0-9]+)/);
                    if (match) {
                        const [_, rtp, rtcp] = match;
                        console.log(`rtp ${rtp} rtcp ${rtcp}`);
                        const rtcpPort = parseInt(rtcp);
                        // have seen some servers return a server_port 0. should watch for bad data in any case.
                        if (rtcpPort) {
                            const rtcpClientPort = setup.dgram.address().port + 1;
                            const rtcpClientUdp = await createBindUdp(rtcpClientPort);
            
                            const rtcpSerUdp = await createBindUdp(rtcpPort);
                            return rtcpUdp;
                        }
                    }

            const rtcpSetupResult = await setupRtcp(setup, setupResult);

            if (rtcpSetupResult) {
                const punch = Buffer.alloc(1);
                const rtcpPort = rtcpSetupResult.port;
                const { hostname } = new URL(client.url);
                rtcpSetupResult.server.send(punch, rtcpPort, hostname);
                rtcpSetupResult.server.on('message', async data => {
                    console.log('received sender report');
                    rtcpSession.onRtcpSr(data);
                    const rr = rtcpSession.buildReceiverReport();
                    console.log('sending receiver report');
                    rtcpSetupResult.server.send(rr);
                });

                server.on('close', () => {
                    console.log('closing rtcp server');
                    closeQuiet(rtcpSetupResult.server);
                });
            }
        }

        server.on('close', () => {
            console.log('closing rtcp proxy');
            serverSocket.destroy();
            client.client.destroy();
        });

        await client.play();
        console.log('client playing');
        await client.readLoop();
    });

    const port = await listenZero(server);
    console.info(`listening on ${port}`);
    return { server, port };
}

async function setupRtcp(setup: RtspClientUdpSetupOptions, response: RtspServerResponse) {
    if (response.headers.transport) {
        const match = response.headers.transport.match(/.*?server_port=([0-9]+)-([0-9]+)/);
        if (match) {
            const [_, rtp, rtcp] = match;
            console.log(`rtp ${rtp} rtcp ${rtcp}`);
            const rtcpPort = parseInt(rtcp);
            // have seen some servers return a server_port 0. should watch for bad data in any case.
            if (rtcpPort) {
                const rtcpClientPort = setup.dgram.address().port + 1;
                const rtcpClientUdp = await createBindUdp(rtcpClientPort);

                const rtcpSerUdp = await createBindUdp(rtcpPort);
                return rtcpUdp;
            }
        }
    }
}

export interface RtcpClientUdpSetupOptions extends RtspClientUdpSetupOptions {
    onRtp: (rtcpHeader: Buffer, rtcp: Buffer) => void;
}

function createBindUdpReuse() 

export default proxyUdpWithRtcp;