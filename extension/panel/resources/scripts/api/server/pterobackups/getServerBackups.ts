import http from '@/api/http';

export interface RemoteBackup {
    id: number;
    date: string;
    size: number;
}

export interface RemoteJob {
    active: boolean;
    name: string | null;
    message: string;
    current: number;
    total: number;
    targetUuid: string | null;
    nextRunNodes: number | null;
    serverNow: number | null;
}

export const rawDataToBackup = (data: any): RemoteBackup => ({
    id: data.id,
    date: data.snapshot_date || data.created_at,
    size: Number(data.size) || 0,
});

export const rawDataToJob = (data: any): RemoteJob => ({
    active: !!data.active,
    name: data.name || null,
    message: data.message || '',
    current: Number(data.current) || 0,
    total: Number(data.total) || 0,
    targetUuid: data.target_uuid || null,
    nextRunNodes: data.next_run_nodes || null,
    serverNow: data.server_now || null,
});

// Las rutas de la extension viven fuera de la API de cliente del panel
// (routes/base.php, sesion normal), por eso no llevan el prefijo /api/client.
export const backupsEndpoint = (uuid: string) => `/pterobackups/server/${uuid}`;

export const getServerBackups = async (uuid: string): Promise<RemoteBackup[]> => {
    const { data } = await http.get(`${backupsEndpoint(uuid)}/list`);

    if (data && data.ok === false) {
        throw new Error(data.message || 'The backup system is not connected yet.');
    }

    return (data.rows || []).map((row: any) => rawDataToBackup(row));
};

export const getBackupJob = async (uuid: string): Promise<RemoteJob> => {
    const { data } = await http.get(`${backupsEndpoint(uuid)}/job`);

    return rawDataToJob(data || {});
};

export default getServerBackups;
