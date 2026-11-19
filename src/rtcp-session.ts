import { RtcpReceiverInfo, RtcpRrPacket, RtcpPacketConverter, RtcpSrPacket, RtpPacket } from 'werift-rtp';

const MAX_DROPOUT = 3000;
const MAX_MISORDER = 100;
const MIN_SEQUENTIAL = 2;
// RTP sequence numbers are unsigned 16-bit values and wrap after 65535.
// This constant is used to convert the sequence number into an extended value.
const RTP_SEQ_MOD = 1 << 16;

interface SequenceInfo {
    /** the synchronization source identifier */
    ssrc: number;
    /** highest seq. number seen */
    maxSeqNum: number;
    /** first sequence number received */
    baseSeqNum: number;
    /** last 'bad' seq number + 1 */
    badSeqNum: number;
    /** shifted count of seq. number cycles */
    cycles: number;
    /** sequ. packets till source is valid */
    probation: number;
    /** packets received */
    received: number;
    /** RTP timestamp of the previous packet */
    lastRtpTimestamp: number;
    /** host arrival time of the previous packet, in microseconds */
    lastArrivalMicros: number;
    /** measured interarrival jitter */
    jitter: number;
    /** expected packets at the previous report */
    expectedPrior: number;
    /** received packets at the previous report */
    receivedPrior: number;
}

export class RtcpSession {
    // The RTCP packet's sender SSRC is separate from the RTP media SSRC
    // reported in each Receiver Report block.
    private readonly rtcpSsrc: number;
    // RTP packets carry timestamps in media-clock units, not microseconds.
    // 90 kHz is the default for H264 streams, and may be overridden if needed.
    private readonly clockRate: number;
    /** sequence information about this source/session */
    private seqInfo?: SequenceInfo;
    /** the most recently received Sender Report */
    private lastSr?: RtcpSrPacket;
    /** the timestamp, in microseconds, the most recent Sender Report was received */
    private lastSrMicros: number = 0;

    constructor(clockRate: number = 90000) {
        // Generate a random local SSRC once so every report from this session
        // identifies the same RTCP sender rather than using the media SSRC.
        this.rtcpSsrc = Math.floor(Math.random() * 0x100000000) >>> 0;
        this.clockRate = clockRate;
    }

    async onRtp(packet: Buffer) {
        const rtpPacket = RtpPacket.deSerialize(packet);
        const seqNum = rtpPacket.header.sequenceNumber;
        const ssrc = rtpPacket.header.ssrc;
        // RTP packets with a new SSRC belong to a new source, so all sequence
        // and timing state must be reinitialized for that source.
        if (!this.seqInfo || this.seqInfo.ssrc !== ssrc) {
            this.seqInfo = {
                ssrc: ssrc,
                maxSeqNum: 0,
                baseSeqNum: seqNum,
                cycles: 0,
                badSeqNum: 0,
                probation: 0,
                received: 0,
                lastRtpTimestamp: rtpPacket.header.timestamp,
                lastArrivalMicros: this.hrToMicros(process.hrtime.bigint()),
                jitter: 0,
                expectedPrior: 0,
                receivedPrior: 0,
            };

            this.initSeqInfo(this.seqInfo, seqNum);
            this.seqInfo.baseSeqNum = seqNum;
            this.seqInfo.probation = MIN_SEQUENTIAL;
        } else {
            const accepted = this.updateSeqInfo(this.seqInfo, seqNum);
            if (accepted) {
                this.updateJitter(rtpPacket.header.timestamp);
            }
        }
    }

    // taken from RFC3550 Appendix A.1
    private initSeqInfo(s: SequenceInfo, seq: number) {
        s.maxSeqNum = seq;
        s.baseSeqNum = seq;
        s.badSeqNum = RTP_SEQ_MOD + 1;   /** so seq == badSeq is false */
        s.cycles = 0;
        s.received = 0;
    }

    private updateJitter(rtpTimestamp: number): void {
        if (!this.seqInfo) {
            return;
        }

        const s = this.seqInfo;
        const arrivalMicros = this.hrToMicros(process.hrtime.bigint());
        const arrivalDelta = arrivalMicros - s.lastArrivalMicros;
        // Convert host arrival spacing from microseconds into the RTP media
        // clock. The difference from the RTP timestamp spacing is then used
        // by the RFC 3550 exponential smoothing formula below.
        const arrivalUnits = Math.round(arrivalDelta * this.clockRate / 1000000);
        const rtpDelta = this.signed32(rtpTimestamp - s.lastRtpTimestamp);
        const d = arrivalUnits - rtpDelta;
        const absoluteD = Math.abs(d);
        s.jitter += (absoluteD - s.jitter) / 16;
        s.lastArrivalMicros = arrivalMicros;
        s.lastRtpTimestamp = rtpTimestamp;
    }

    private signed32(value: number): number {
        // RTP timestamps use signed 32-bit arithmetic for differences. This
        // also handles timestamp wraparound correctly.
        value |= 0;
        return value;
    }

    // taken from RFC3550 Appendix A.1
    private updateSeqInfo(s: SequenceInfo, seq: number): number {
        let udelta = seq - s.maxSeqNum;
        // Normalize the result to the closest sequence distance. The added
        // and subtracted 32768 approach handles packets immediately before
        // or after the 16-bit sequence-number boundary.
        if (udelta < -RTP_SEQ_MOD / 2) {
            udelta += RTP_SEQ_MOD;
        } else if (udelta > RTP_SEQ_MOD / 2) {
            udelta -= RTP_SEQ_MOD;
        }

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
        } else if (udelta < 0) {
            // duplicate or reordered packet
        } else if (udelta < MAX_DROPOUT) {
            // in order, with permissible gap
            if (seq < s.maxSeqNum) {
                /*
                 * Sequence number wrapped - count another 64K cycle.
                 */
                s.cycles += RTP_SEQ_MOD;
            }
            s.maxSeqNum = seq;
        } else if (udelta < 0 && udelta >= -MAX_MISORDER) {
            // duplicate or reordered packet
        } else if (udelta > RTP_SEQ_MOD - MAX_MISORDER) {
            // duplicate or reordered packet
        } else if (udelta >= 0) {
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
        // Compound RTCP packets can contain more than one report type. Find
        // the Sender Report and ignore unrelated packets in the same datagram.
        const sr = rtcpPackets.find(packet => packet.type === 200) as RtcpSrPacket | undefined;
        if (!sr) {
            return;
        }
        this.lastSr = sr;
        this.lastSrMicros = this.hrToMicros(process.hrtime.bigint());
    }

    buildReceiverReport(): RtcpRrPacket | undefined {
        if (!this.seqInfo || !this.lastSr) {
            return;
        }

        const ssrc = this.seqInfo.ssrc;
        // An extended sequence number combines the 16-bit value with the
        // number of sequence cycles already observed.
        const highestSequence = this.seqInfo.cycles + this.seqInfo.maxSeqNum;
        const expected = highestSequence - this.seqInfo.baseSeqNum + 1;
        const lost = expected - this.seqInfo.received;
        // The RFC stores cumulative packets lost as a signed 24-bit integer.
        // Werift serializes this field as unsigned bytes, so encode negative
        // values as their 24-bit two's-complement representation.
        const packetsLostSigned = Math.max(-0x800000, Math.min(0x7fffff, lost));
        const packetsLost = packetsLostSigned < 0
            ? 0x1000000 + packetsLostSigned
            : packetsLostSigned;
        const intervalExpected = expected - this.seqInfo.expectedPrior;
        const intervalReceived = this.seqInfo.received - this.seqInfo.receivedPrior;
        const intervalLost = intervalExpected - intervalReceived;
        // fractionLost is the fraction of packets lost since the preceding
        // report, expressed as an unsigned 8-bit fixed-point value.
        const fractionLost = intervalExpected > 0
            ? Math.max(0, Math.min(255, Math.round((intervalLost * 256) / intervalExpected)))
            : 0;
        const jitter = Math.max(0, Math.min(0xffffffff, Math.round(this.seqInfo.jitter)));

        this.seqInfo.expectedPrior = expected;
        this.seqInfo.receivedPrior = this.seqInfo.received;

        // last SR timestamp (LSR): 32 bits
        // RTCP copies the middle 32 bits of the Sender Report's 64-bit NTP
        // timestamp into LSR. This identifies which SR the receiver observed.
        const lsr = Number((this.lastSr.senderInfo.ntpTimestamp >> 16n) & 0xffffffffn);

        // The delay, expressed in units of 1/65536 seconds, between receiving the last SR packet from source SSRC_n 
        // and sending this reception report block.
        const micros = this.hrToMicros(process.hrtime.bigint());
        // DLSR is stored in 1/65536-second units, not milliseconds or
        // microseconds. Convert elapsed microseconds and clamp to 32 bits.
        const dlsr = Math.max(0, Math.min(0xffffffff,
            Math.round((micros - this.lastSrMicros) * 65536 / 1000000)));

        // Build and return the Receiver Report.
        const reports = [new RtcpReceiverInfo({ ssrc, fractionLost, packetsLost, highestSequence, jitter, lsr, dlsr })];

        // The report block names the source media SSRC; the packet-level
        // ssrc identifies this receiver and is the separately generated SSRC.
        return new RtcpRrPacket({ ssrc: this.rtcpSsrc, reports });
    }

    private hrToMicros(hrTs: bigint): number {
        // process.hrtime.bigint() is nanoseconds, while RTCP DLSR and arrival
        // calculations in this session use microseconds.
        return Number(hrTs / 1000n);
    }
}