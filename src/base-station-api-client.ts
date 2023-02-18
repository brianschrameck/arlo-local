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

    public async listDevices(): Promise<DeviceSummary[]> {
        return await this.sendRequest<DeviceSummary[]>('/device');
    }

    public async postGenerateStatusRequest(serialNumber: string): Promise<GenericResponse> {
        return await this.sendRequest<GenericResponse>(`/device/${serialNumber}/statusrequest`, 'post');
    }

    public async getStatus(serialNumber: string): Promise<DeviceStatus> {
        return await this.sendRequest<DeviceStatus>(`/device/${serialNumber}`);
    }

    public async getRegistration(serialNumber: string): Promise<DeviceRegistration> {
        return await this.sendRequest<DeviceRegistration>(`/device/${serialNumber}/registration`);
    }

    public async postSnapshotRequest(serialNumber: string): Promise<GenericResponse> {
        const data = { url: `${this.baseUrl}/snapshot/${serialNumber}/${serialNumber}.jpg` };
        return await this.sendRequest<GenericResponse>(`/device/${serialNumber}/snapshot`, 'post', data);
    }

    public async getSnapshot(serialNumber: string): Promise<Buffer> {
        let buffer: Buffer;
        let attempt = 0;
        while (!buffer && attempt < 3) {
            console.info(`${serialNumber}: requesting snapshot`)
            try {
                buffer = await this.sendFileRequest(`/snapshot/${serialNumber}`);
                console.debug(`${serialNumber}: snapshot retrieval succeeded on attempt ${attempt + 1}`);
            } catch {
                await sleep(1000);
                attempt++;
                console.error(`${serialNumber}: snapshot retrieval attempt ${attempt} failed`);
            }
        }
        return buffer;
    }

    public async postUserStreamActive(serialNumber: string, isActive: boolean): Promise<GenericResponse> {
        const data = { active: Number(isActive) };
        return await this.sendRequest<GenericResponse>(`/device/${serialNumber}/userstreamactive`, 'post', data);
    }

    public async postArm(serialNumber: string, pirTargetState: string, pirStartSensitivity: number) {
        const data = { PIRTargetState: pirTargetState, PIRStartSensitivity: pirStartSensitivity };
        return await this.sendRequest<GenericResponse>(`/device/${serialNumber}/arm `, 'post', data);
    }

    public async postQuality(serialNumber: string, quality: string) {
        const data = { quality: quality };
        return await this.sendRequest<GenericResponse>(`/device/${serialNumber}/quality `, 'post', data);
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

export interface GenericResponse {
    result: boolean
}

export interface DeviceSummary {
    friendly_name: string;
    hostname: string;
    ip: string;
    serial_number: string;
}

export interface DeviceStatus {
    Bat1Volt: number,
    BatPercent: number,
    BatTech: string,
    CriticalBatStatus: number,
    FailedStreams: number,
    FailedUpgrades: number,
    HardwareRevision: string,
    ID: number,
    LogFrequency: number,
    PIREvents: number,
    SignalStrengthIndicator: number,
    SystemFirmwareVersion: string,
    SystemSerialNumber: string,
    Type: string,
    WifiConnectionAttempts: number,
    WifiConnectionCount: number
}

export interface AudioDoorbellStatus extends DeviceStatus {
    ButtonEvents: number,
    Hibernate: string, // boolean string
    WifiCountryDetails: string,
    WifiCountryRegion: number
}

export interface CameraStatus extends DeviceStatus {
    Battery1CaliVoltage: number,
    CameraOffline: number,
    CameraOnline: number,
    ChargerTech: string,
    ChargingState: string,
    DdrFailCnt: number,
    DhcpFCnt: number,
    IRLEDsOn: number,
    ISPOn: number,
    ISPWatchdogCount: number,
    ISPWatchdogCount2: number,
    MotionStreamed: number,
    PercentAtPlug: number,
    PercentAtUnPlug: number,
    PoweredOn: number,
    RegFCnt: number,
    RtcpDiscCnt: number,
    SecsPerPercentAvg: number,
    SecsPerPercentCurr: number,
    SnapshotCount: number,
    Streamed: number,
    Temperature: number,
    TimeAtPlug: number,
    TimeAtUnPlug: number,
    TxErr: number,
    TxFail: number,
    TxPhyE1: number,
    TxPhyE2: number,
    UpdateSystemModelNumber: string,
    UserStreamed: number
}

export interface DeviceRegistration {
    BatPercent: number,
    BatTech: string,
    Capabilities: [string],
    CommProtocolVersion: number,
    HardwareRevision: string,
    ID: number,
    InterfaceVersion: number,
    LogFrequency: number,
    SignalStrengthIndicator: number,
    Sync: string, // boolean string
    SystemFirmwareVersion: string,
    SystemModelNumber: string,
    SystemSerialNumber: string,
    Type: string
}

export interface AudioDoorbellRegistration {
    BCC: string,
    RtpPort: number,
    SKU: string,
}

export interface CameraRegistration {
    BattChargeMaxTemp: number,
    BattChargeMinTemp: number,
    BootSeconds: number,
    ChargerTech: string,
    ChargingState: string,
    Temperature: number,
    ThermalShutdownMaxTemp: number,
    ThermalShutdownMinTemp: number,
    ThermalShutdownRechargeMaxTemp: number,
    UpdateSystemModelNumber: string
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

export interface RegisteredEvent extends WebhookEvent {
    // annoyingly, it's not easy to return nested JSON using 
    // the default JSON serializer in Python, so we receive a 
    // stringified JSON object here
    registration: string
}

export interface StatusUpdatedEvent extends WebhookEvent {
    // same annoying problem as registration
    status: string
}

export interface ButtonPressedEvent extends WebhookEvent {
    triggered: string // boolean string
}