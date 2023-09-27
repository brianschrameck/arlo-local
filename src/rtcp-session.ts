import { RtcpReceiverInfo, RtcpRrPacket, RtcpPacketConverter, RtcpSrPacket, RtpPacket } from 'werift';

const MAX_DROPOUT = 3000;
const MAX_MISORDER = 100;
const MIN_SEQUENTIAL = 2;
const RTP_SEQ_MOD = 1 << 16;

interface SequenceInfo {
    /** the synchronization source identifier */
    ssrc: number;
    /** highest seq. number seen */
    maxSeqNum: number;
    /** last 'bad' seq number + 1 */
    badSeqNum: number;
    /** shifted count of seq. number cycles */
    cycles: number;
    /** sequ. packets till source is valid */
    probation: number;
    /** packets received */
    received: number;
}

export class RtcpSession {
    /** sequence information about this source/session */
    private seqInfo?: SequenceInfo;
    /** the most recently received Sender Report */
    private lastSr?: RtcpSrPacket;
    /** the timestamp, in microseconds, the most recent Sender Report was received */
    private lastSrMicros: number = 0;

    async onRtp(packet: Buffer) {
        const rtpPacket = RtpPacket.deSerialize(packet);
        const seqNum = rtpPacket.header.sequenceNumber;
        const ssrc = rtpPacket.header.ssrc;
        if (!this.seqInfo) {
            this.seqInfo = {
                ssrc: ssrc,
                maxSeqNum: 0,
                cycles: 0,
                badSeqNum: 0,
                probation: 0,
                received: 0,
            };

            this.initSeqInfo(this.seqInfo, seqNum);
            this.seqInfo.maxSeqNum = seqNum - 1;
            this.seqInfo.probation = MIN_SEQUENTIAL;
        } else {
            this.updateSeqInfo(this.seqInfo, seqNum);
        }
    }

    // taken from RFC3550 Appendix A.1
    private initSeqInfo(s: SequenceInfo, seq: number) {
        s.maxSeqNum = seq;
        s.badSeqNum = RTP_SEQ_MOD + 1;   /** so seq == badSeq is false */
        s.cycles = 0;
        s.received = 0;
    }

    // taken from RFC3550 Appendix A.1
    private updateSeqInfo(s: SequenceInfo, seq: number): number {
        let udelta = seq - s.maxSeqNum;

        /*
         * Source is not valid until MIN_SEQUENTIAL packets with
         * sequential sequence numbers have been received.
         */
        if (s.probation) {
            // packet is in sequence
            if (seq == s.maxSeqNum + 1) {
                s.probation--;
                s.maxSeqNum = seq;
                if (s.probation == 0) {
                    this.initSeqInfo(s, seq);
                    s.received++;
                    return 1;
                }
            } else {
                s.probation = MIN_SEQUENTIAL - 1;
                s.maxSeqNum = seq;
            }
            return 0;
        } else if (udelta < MAX_DROPOUT) {
            // in order, with permissible gap
            if (seq < s.maxSeqNum) {
                /*
                 * Sequence number wrapped - count another 64K cycle.
                 */
                s.cycles += RTP_SEQ_MOD;
            }
            s.maxSeqNum = seq;
        } else if (udelta <= RTP_SEQ_MOD - MAX_MISORDER) {
            // the sequence number made a very large jump
            if (seq == s.badSeqNum) {
                /*
                 * Two sequential packets -- assume that the other side
                 * restarted without telling us so just re-sync
                 * (i.e., pretend this was the first packet).
                 */
                this.initSeqInfo(s, seq);
            }
            else {
                s.badSeqNum = (seq + 1) & (RTP_SEQ_MOD - 1);
                return 0;
            }
        } else {
            // duplicate or reordered packet
        }
        s.received++;
        return 1;
    }

    onRtcpSr(packet: Buffer) {
        const rtcpPackets = RtcpPacketConverter.deSerialize(packet);
        const sr = rtcpPackets.find(packet => packet.type === 200) as RtcpSrPacket;
        this.lastSr = sr;
        this.lastSrMicros = this.hrToMicros(process.hrtime.bigint());
    }

    buildReceiverReport(): RtcpRrPacket | undefined {
        if (!this.seqInfo || !this.lastSr) {
            return;
        }

        const ssrc = this.seqInfo.ssrc;
        const fractionLost = 0;
        const packetsLost = 0;
        const highestSequence = this.seqInfo.maxSeqNum;
        const jitter = 0;

        // last SR timestamp (LSR): 32 bits
        // The middle 32 bits out of 64 in the NTP timestamp received as part of the most recent RTCP sender report (SR)
        // packet from source SSRC_n.
        const lastSrTimestamp = this.lastSr.senderInfo.ntpTimestamp;
        // Convert to buffer and take the middle 32 bits.
        const lastSrBuf = this.getUInt64Bytes(lastSrTimestamp).subarray(2, 6);
        // Convert to a number.
        const lsr = this.intFromBytes(lastSrBuf);

        // The delay, expressed in units of 1/65536 seconds, between receiving the last SR packet from source SSRC_n 
        // and sending this reception report block.
        const micros = this.hrToMicros(process.hrtime.bigint());
        const dlsr = (micros - this.lastSrMicros) * 1000000 / 65536;

        // Build and return the Receiver Report.
        const reports = [new RtcpReceiverInfo({ ssrc, fractionLost, packetsLost, highestSequence, jitter, lsr, dlsr })];
        return new RtcpRrPacket({ ssrc, reports });
    }

    private hrToMicros(hrTs: bigint): number {
        return (hrTs[0] * 1000000) + (hrTs[1] / 1000);
    }

    private getUInt64Bytes(x: bigint): Buffer {
        const bytes = Buffer.alloc(8);
        bytes.writeBigUInt64LE(x);
        return bytes;
    }

    private intFromBytes(x: Buffer): number {
        return x.readUint32LE();
    }
}