import http from '@/api/http';
import { backupsEndpoint } from '@/api/server/pterobackups/getServerBackups';

export default async (uuid: string, backup: number, wipe: boolean): Promise<void> => {
    const { data } = await http.post(`${backupsEndpoint(uuid)}/restore/${backup}`, { wipe: wipe ? 1 : 0 });

    // El sistema de copias contesta 200 con { ok: false } cuando rechaza la
    // peticion (por ejemplo si la copia es de otro servidor), asi que hay que
    // mirar el cuerpo y no solo el codigo HTTP.
    if (data && data.ok === false) {
        throw new Error(data.message || 'The backup could not be restored.');
    }
};
