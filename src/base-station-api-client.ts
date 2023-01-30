import axios, { AxiosInstance, Method } from 'axios';
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
            baseURL: `${baseUrl}/camera`,
            timeout: 10000,
            httpsAgent,
        });
    }

    public async listCameras(): Promise<CameraSummary[]> {
        const response = await this.sendRequest<CameraSummary[]>();
        return response;
    }

    public async postGenerateStatusRequest(serialNumber: string): Promise<CameraResponse> {
        const response = await this.sendRequest<CameraResponse>(`/${serialNumber}/statusrequest`, 'post');
        return response;
    }

    public async getCameraStatus(serialNumber: string): Promise<CameraStatus> {
        const response = await this.sendRequest<CameraStatus>(`/${serialNumber}`);
        return response;
    }

    public async getCameraRegistration(serialNumber: string): Promise<CameraStatus> {
        const response = await this.sendRequest<CameraStatus>(`/${serialNumber}/registration`);
        return response;
    }

    public async postSnapshotRequest(serialNumber: string): Promise<CameraResponse> {
        // TODO: implement this { url: "http://172.14.1.1:5000/snapshot/blah/temp.jpg" }

        const response = await this.sendRequest<CameraResponse>(`/${serialNumber}/snapshot`);
        return response;
    }

    public async postUserStreamActive(serialNumber: string, isActive: boolean): Promise<CameraResponse> {
        const response = await this.sendRequest<CameraResponse>(`/${serialNumber}/userstreamactive`, 'post', { active: Number(isActive) });
        return response;
    }

    private async sendRequest<T>(url?: string, method?: Method, data?: any): Promise<T> {
        try {
            await sleep(200);
            const response = await this.client.request<T>({ url, method, data })
            return response.data;
        } catch (error) {
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