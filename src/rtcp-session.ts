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
    private lastSr?: Buffer;
    /** the timestamp, in microseconds, the most recent Sender Report was received */
    private lastSrMicros?: number;

    /**
     *     0                   1                   2                   3
     *     0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1
     *    +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
     *    |V=2|P|X|  CC   |M|     PT      |       sequence number         |
     *    +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
     *    |                           timestamp                           |
     *    +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
     *    |           synchronization source (SSRC) identifier            |
     *    +=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+
     *    |            contributing source (CSRC) identifiers             |
     *    |                             ....                              |
     *    +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
     */
    onRtp(packet: Buffer) {
        const seqNum = packet.readUInt16BE(2);
        const ssrc = packet.readUInt32BE(8);
        if (!this.seqInfo) {
            this.seqInfo = {
                ssrc: ssrc,
                maxSeqNum: undefined,
                cycles: undefined,
                badSeqNum: undefined,
                probation: undefined,
                received: undefined,
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
        this.lastSr = packet;
        this.lastSrMicros = this.hrToMicros(process.hrtime.bigint());
    }

    /**
     *        0                   1                   2                   3
     *         0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1
     *        +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
     * header |V=2|P|    RC   |   PT=RR=201   |             length            |
     *        +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
     *        |                     SSRC of packet sender                     |
     *        +=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+
     * report |                 SSRC_1 (SSRC of first source)                 |
     * block  +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
     *   1    | fraction lost |       cumulative number of packets lost       |
     *        +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
     *        |           extended highest sequence number received           |
     *        +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
     *        |                      interarrival jitter                      |
     *        +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
     *        |                         last SR (LSR)                         |
     *        +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
     *        |                   delay since last SR (DLSR)                  |
     *        +=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=
     */
    buildReceiverReport(): Buffer {
        if (!this.seqInfo) {
            // we haven't seen any data yet
            return Buffer.alloc(1);
        }

        const rr = Buffer.alloc(32);
        rr.writeUInt8(129);                           // V=2|P|RC: 10|0|00001 (V2|0|1)
        rr.writeUInt8(201, 1);                        // PT=RR=201
        rr.writeUInt16BE(7, 2);                       // length: 8 32-bit words - 1 = 7
        rr.writeUInt32BE(0, 4);                       // SSRC of packet sender: 0
        rr.writeUInt32BE(this.seqInfo.ssrc, 8);       // SSRC_1 (SSRC of first source)
        rr.writeUInt32BE(0, 12);                      // fraction lost|cumulative number of packets lost
        rr.writeUInt16BE(this.seqInfo.cycles, 16);    // count of sequence number cycles
        rr.writeUInt32BE(this.seqInfo.maxSeqNum, 18); // highest sequence number received in an RTP data packet from source
        rr.writeUInt32BE(0, 20);                      // interarrival jitter

        // last SR timestamp (LSR): 32 bits
        // The middle 32 bits out of 64 in the NTP timestamp received as part of the most recent RTCP sender report (SR)
        // packet from source SSRC_n.  If no SR has been received yet, the field is set to zero.
        const lastSrTimestamp = this.lastSr ? this.lastSr.readUInt32BE(10) : 0;
        rr.writeUInt32BE(lastSrTimestamp, 24);        // last SR (LSR)

        // The delay, expressed in units of 1/65536 seconds, between receiving the last SR packet from source SSRC_n 
        // and sending this reception report block.
        // If no SR packet has been received yet from SSRC_n, the DLSR field is set to zero.
        const micros = this.hrToMicros(process.hrtime.bigint());
        const delaySinceLastSr = this.lastSr ? (micros - this.lastSrMicros) * 1000000 / 65536 : 0;
        rr.writeUInt32BE(delaySinceLastSr, 28);       // delay since last SR (DLSR)
        return rr;
    }

    private hrToMicros(hrTs: bigint): number {
        return (hrTs[0] * 1000000) + (hrTs[1] / 1000);
    }
}