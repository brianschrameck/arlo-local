import axios, { AxiosError, AxiosInstance, Method } from 'axios';
import https from 'https';
import { sleep } from '@scrypted/common/src/sleep';

const httpsAgent = new https.Agent({
    rejectUnauthorized: false,
});

export class BaseStationApiClient {
    private readonly client: AxiosInstance;

    public readonly baseUrl: string;

    constructor(baseUrl: string) {
        this.baseUrl = baseUrl;
        this.client = axios.create({
            baseURL: `${baseUrl}`,
            timeout: 10000,
            httpsAgent,
        });
    }

    public async listCameras(): Promise<CameraSummary[]> {
        return await this.sendRequest<CameraSummary[]>('/camera');
    }

    public async postGenerateStatusRequest(serialNumber: string): Promise<CameraResponse> {
        return await this.sendRequest<CameraResponse>(`/camera/${serialNumber}/statusrequest`, 'post');
    }

    public async getCameraStatus(serialNumber: string): Promise<CameraStatus> {
        return await this.sendRequest<CameraStatus>(`/camera/${serialNumber}`);
    }

    public async getCameraRegistration(serialNumber: string): Promise<CameraStatus> {
        return await this.sendRequest<CameraStatus>(`/camera/${serialNumber}/registration`);
    }

    public async postSnapshotRequest(serialNumber: string): Promise<CameraResponse> {
        const data = { url: `${this.baseUrl}/snapshot/${serialNumber}/${serialNumber}.jpg` };
        return await this.sendRequest<CameraResponse>(`/camera/${serialNumber}/snapshot`, 'post', data);
    }

    public async getSnapshot(serialNumber: string): Promise<Buffer> {
        let buffer: Buffer;
        let attempt = 0;
        while (!buffer && attempt < 3) {
            console.info(`Requesting snapshot: ${serialNumber}`)
            buffer = await this.sendFileRequest(`/snapshot/${serialNumber}`);
            if (!buffer) {
                await sleep(1000);
            }
            attempt++;
        }
        return buffer;
    }

    public async postUserStreamActive(serialNumber: string, isActive: boolean): Promise<CameraResponse> {
        const data = { active: Number(isActive) };
        return await this.sendRequest<CameraResponse>(`/camera/${serialNumber}/userstreamactive`, 'post', data);
    }

    private async sendRequest<T>(url?: string, method?: Method, data?: any): Promise<T> {
        try {
            const response = await this.client.request<T>({ url, method, data })
            return response.data;
        } catch (error) {
            this.handleError(error);
        }
    }

    private async sendFileRequest<T>(url?: string): Promise<Buffer> {
        const response = await this.client.request<Buffer>({ url, responseType: 'arraybuffer' })
        return response.data;
    }

    private handleError(error: AxiosError) {
        if (error.response) {
            // Request made but the server responded with an error
            console.log(error.response.data);
            console.log(error.response.status);
            console.log(error.response.headers);
        } else if (error.request) {
            // Request made but no response is received from the server.
            console.log(error.request);
        } else {
            // Error occured while setting up the request
            console.log('Error', error.message);
        }
    }
}

export interface CameraResponse {
    result: boolean
}

export interface CameraSummary {
    friendly_name: string;
    hostname: string;
    ip: string;
    serial_number: string;
}

export interface CameraStatus {
    Bat1Volt: number,
    BatPercent: number,
    BatTech: string,
    Battery1CaliVoltage: number,
    CameraOffline: number,
    CameraOnline: number,
    ChargerTech: string,
    ChargingState: string,
    CriticalBatStatus: number,
    DdrFailCnt: number,
    DhcpFCnt: number,
    FailedStreams: number,
    FailedUpgrades: number,
    HardwareRevision: string,
    ID: number,
    IRLEDsOn: number,
    ISPOn: number,
    ISPWatchdogCount: number,
    ISPWatchdogCount2: number,
    LogFrequency: number,
    MotionStreamed: number,
    PIREvents: number,
    PercentAtPlug: number,
    PercentAtUnPlug: number,
    PoweredOn: number,
    RegFCnt: number,
    RtcpDiscCnt: number,
    SecsPerPercentAvg: number,
    SecsPerPercentCurr: number,
    SignalStrengthIndicator: number,
    SnapshotCount: number,
    Streamed: number,
    SystemFirmwareVersion: string,
    SystemSerialNumber: string,
    Temperature: number,
    TimeAtPlug: number,
    TimeAtUnPlug: number,
    TxErr: number,
    TxFail: number,
    TxPhyE1: number,
    TxPhyE2: number,
    Type: string,
    UpdateSystemModelNumber: string,
    UserStreamed: number,
    WifiConnectionAttempts: number,
    WifiConnectionCount: number,
    WifiCountryDetails: string
}

export interface WebhookEvent {
    ip: string,
    friendly_name: string,
    hostname: string,
    serial_number: string,
}

export interface MotionDetectedEvent extends WebhookEvent {
    zone: [],
    file_name: string,
    time: Number
}

export interface StatusUpdatedEvent extends WebhookEvent {
    // annoyingly, it's not easy to return nested JSON using 
    // the default JSON serializer in Python, so we receive a 
    // stringified JSON object here
    status: string
}