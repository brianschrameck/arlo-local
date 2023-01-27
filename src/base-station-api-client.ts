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

    public async listCameras(): Promise<BaseStationCameraSummary[]> {
        const response = await this.sendRequest<BaseStationCameraSummary[]>();

        return response;
    }

    public async postGenerateStatusRequest(serialNumber: string): Promise<BaseStationCameraResponse> {
        const response = await this.sendRequest<BaseStationCameraResponse>(`/${serialNumber}/statusrequest`, 'post');

        return { serialNumber, ...response };
    }

    public async getCameraStatus(serialNumber: string): Promise<BaseStationCameraStatus> {
        const response = await this.sendRequest<BaseStationCameraStatus>(`/${serialNumber}`);

        return response;
    }

    public async getCameraRegistration(serialNumber: string): Promise<BaseStationCameraStatus> {
        const response = await this.sendRequest<BaseStationCameraStatus>(`/${serialNumber}/registration`);

        return response;
    }

    public async postSnapshotRequest(serialNumber: string): Promise<BaseStationCameraResponse> {
        { url: "http://172.14.1.1:5000/snapshot/blah/temp.jpg" }

        const response = await this.sendRequest<BaseStationCameraResponse>(`/${serialNumber}/snapshot`);

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

export interface BaseStationCameraResponse {
    serialNumber: string,
    result: boolean
}

export interface BaseStationCameraSummary {
    friendly_name: string;
    hostname: string;
    ip: string;
    serial_number: string;
}

export interface BaseStationCameraStatus {
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

export interface BaseStationCameraRegistration {
    BatPercent: number,
    BatTech: string,
    BattChargeMaxTemp: number,
    BattChargeMinTemp: number,
    BootSeconds: number,
    Capabilities: [string],
    ChargerTech: string,
    ChargingState: string,
    CommProtocolVersion: number,
    HardwareRevision: string,
    ID: number,
    InterfaceVersion: number,
    LogFrequency: number,
    SignalStrengthIndicator: number,
    Sync: boolean,
    SystemFirmwareVersion: string,
    SystemModelNumber: string,
    SystemSerialNumber: string,
    Temperature: number,
    ThermalShutdownMaxTemp: number,
    ThermalShutdownMinTemp: number,
    ThermalShutdownRechargeMaxTemp: number,
    Type: string,
    UpdateSystemModelNumber: string
}

export interface MotionDetectedEvent {
    ip: string,
    friendly_name: string,
    hostname: string,
    serial_number: string,
    zone: [],
    file_name: string,
    time: Number
}