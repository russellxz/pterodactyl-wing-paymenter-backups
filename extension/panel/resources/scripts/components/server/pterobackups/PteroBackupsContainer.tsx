import React, { useEffect, useRef, useState } from 'react';
import tw from 'twin.macro';
import { ServerContext } from '@/state/server';
import Spinner from '@/components/elements/Spinner';
import FlashMessageRender from '@/components/FlashMessageRender';
import ServerContentBlock from '@/components/elements/ServerContentBlock';
import useFlash from '@/plugins/useFlash';
import { httpErrorToHuman } from '@/api/http';
import getServerBackups, { getBackupJob, RemoteBackup, RemoteJob } from '@/api/server/pterobackups/getServerBackups';
import restoreServerBackup from '@/api/server/pterobackups/restoreServerBackup';
import BackupRow from '@/components/server/pterobackups/BackupRow';

// Ritmo de consulta del estado: rapido solo mientras se restaura este servidor,
// lento cuando no pasa nada y en pausa con la pestana oculta. Insistir cada
// pocos segundos sin parar es justo lo que hace que Cloudflare nos tome por un
// bot y acabe mostrando su pantalla de comprobacion.
const POLL_FAST = 4000;
const POLL_IDLE = 30000;
const POLL_MAX_FAILS = 6;

const fmtCountdown = (ms: number): string => {
    const total = Math.max(0, Math.floor(ms / 1000));
    const d = Math.floor(total / 86400);
    const h = Math.floor((total % 86400) / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;

    return `${d > 0 ? `${d}d ` : ''}${String(h).padStart(2, '0')}h ${String(m).padStart(2, '0')}m ${String(s).padStart(2, '0')}s`;
};

export default () => {
    const uuid = ServerContext.useStoreState((state) => state.server.data!.uuid);
    const { clearFlashes, addError, addFlash } = useFlash();

    const [loading, setLoading] = useState(true);
    const [backups, setBackups] = useState<RemoteBackup[]>([]);
    const [job, setJob] = useState<RemoteJob | null>(null);
    const [nextRunAt, setNextRunAt] = useState<number | null>(null);
    const [now, setNow] = useState(Date.now());

    // Refs para que el bucle de consulta no se reinicie en cada render.
    const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const fails = useRef(0);
    const stopped = useRef(false);
    const wasRestoring = useRef(false);

    const loadBackups = () => {
        return getServerBackups(uuid)
            .then(setBackups)
            .catch((error) => {
                addError({ message: error.message || httpErrorToHuman(error), key: 'pterobackups' });
            });
    };

    useEffect(() => {
        clearFlashes('pterobackups');
        loadBackups().then(() => setLoading(false));

        const schedule = (ms: number) => {
            if (stopped.current) return;
            if (timer.current) clearTimeout(timer.current);
            timer.current = setTimeout(poll, ms);
        };

        const poll = () => {
            if (stopped.current) return;
            if (document.hidden) {
                schedule(POLL_IDLE);
                return;
            }

            getBackupJob(uuid)
                .then((next) => {
                    fails.current = 0;

                    // La tarea puede ser de otro servidor: solo se muestra la
                    // barra cuando lo que se restaura es ESTE servidor.
                    const mine = next.active && next.targetUuid === uuid;
                    setJob(mine ? next : null);

                    // Al terminar una restauracion nuestra, refrescamos la lista.
                    if (wasRestoring.current && !mine) loadBackups();
                    wasRestoring.current = mine;

                    // El contador se pasa al reloj del navegador y se repinta
                    // solo, sin volver a pedir nada al servidor.
                    setNextRunAt(
                        next.nextRunNodes ? Date.now() + (next.nextRunNodes - (next.serverNow || Date.now())) : null
                    );

                    schedule(mine ? POLL_FAST : POLL_IDLE);
                })
                .catch(() => {
                    // Si algo falla, esperamos cada vez mas en vez de insistir.
                    fails.current += 1;
                    if (fails.current >= POLL_MAX_FAILS) {
                        stopped.current = true;
                        return;
                    }
                    schedule(Math.min(POLL_IDLE * fails.current, 180000));
                });
        };

        const onVisible = () => {
            if (!document.hidden && !stopped.current) schedule(500);
        };

        poll();
        document.addEventListener('visibilitychange', onVisible);

        // El contador se refresca en local: no cuesta ni una peticion.
        const tick = setInterval(() => setNow(Date.now()), 1000);

        return () => {
            stopped.current = true;
            if (timer.current) clearTimeout(timer.current);
            clearInterval(tick);
            document.removeEventListener('visibilitychange', onVisible);
        };
    }, [uuid]);

    const onRestore = (backup: RemoteBackup) => {
        if (job) {
            addError({ message: 'A restore is already running for your server. Wait for it to finish.', key: 'pterobackups' });
            return;
        }
        if (!confirm(`Restore the backup from ${backup.date} to your server? The backup files will overwrite the current ones.`)) {
            return;
        }

        const wipe = confirm(
            'Do you want to WIPE the current files before restoring?\n\nOK = wipe and restore clean.\nCancel = restore on top of the current files.'
        );

        clearFlashes('pterobackups');
        restoreServerBackup(uuid, backup.id, wipe)
            .then(() => {
                wasRestoring.current = true;
                addFlash({
                    type: 'success',
                    key: 'pterobackups',
                    message: 'Restore started. You can follow the progress here.',
                });
            })
            .catch((error) => {
                addError({ message: error.message || httpErrorToHuman(error), key: 'pterobackups' });
            });
    };

    if (loading) {
        return <Spinner size={'large'} centered />;
    }

    return (
        <ServerContentBlock title={'Backup 2.0'}>
            <FlashMessageRender byKey={'pterobackups'} css={tw`mb-4`} />

            {nextRunAt !== null && (
                <div css={tw`bg-neutral-700 rounded p-4 mb-4`}>
                    <p css={tw`text-xs uppercase text-neutral-400`}>Next automatic backup</p>
                    <p css={tw`text-lg mt-1`}>{fmtCountdown(nextRunAt - now)}</p>
                </div>
            )}

            {job && (
                <div css={tw`bg-neutral-700 rounded p-4 mb-4`}>
                    <div css={tw`flex items-center`}>
                        <Spinner size={'small'} />
                        <p css={tw`ml-3 flex-1`}>{job.name || 'Restoring your server'}</p>
                        {job.total > 0 && (
                            <p css={tw`text-sm text-neutral-300`}>
                                {job.current} / {job.total}
                            </p>
                        )}
                    </div>
                    <div css={tw`mt-3 h-2 bg-neutral-800 rounded overflow-hidden`}>
                        <div
                            css={tw`h-full bg-primary-500`}
                            style={{ width: `${job.total > 0 ? Math.round((job.current / job.total) * 100) : 0}%` }}
                        />
                    </div>
                    {!!job.message && <p css={tw`text-xs text-neutral-400 mt-2`}>{job.message}</p>}
                </div>
            )}

            {backups.length < 1 ? (
                <p css={tw`text-center text-sm text-neutral-300`}>
                    Your server has no backups yet. They are created automatically on the schedule your administrator
                    set.
                </p>
            ) : (
                backups.map((backup, index) => (
                    <BackupRow
                        key={backup.id}
                        uuid={uuid}
                        backup={backup}
                        disabled={job !== null}
                        onRestore={onRestore}
                        className={index > 0 ? 'mt-2' : undefined}
                    />
                ))
            )}
        </ServerContentBlock>
    );
};
