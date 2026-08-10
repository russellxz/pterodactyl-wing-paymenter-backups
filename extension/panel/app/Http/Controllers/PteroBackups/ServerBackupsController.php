<?php

namespace Pterodactyl\Http\Controllers\PteroBackups;

use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Pterodactyl\Http\Controllers\Controller;
use Pterodactyl\PteroBackups\Client;

/**
 * Página "Copias Remotas" de cada servidor (área de usuario).
 * Solo el dueño del servidor (o un administrador) puede entrar, y solo puede
 * tocar copias que pertenezcan a ESE servidor.
 */
class ServerBackupsController extends Controller
{
    protected function findServer(Request $request, string $short)
    {
        $server = DB::table('servers')
            ->where('uuidShort', $short)
            ->orWhere('uuid', $short)
            ->first();
        abort_unless($server, 404);

        $user = $request->user();
        abort_unless($user, 403);
        if (!$user->root_admin && (int) $server->owner_id !== (int) $user->id) {
            abort(403, 'No tienes acceso a las copias de este servidor.');
        }

        return $server;
    }

    public function list(Request $request, string $short)
    {
        $server = $this->findServer($request, $short);
        if (!Client::configured()) {
            return response()->json(['ok' => false, 'message' => 'El sistema de copias todavía no está conectado.']);
        }

        return response()->json(Client::get('/api/ext/server/' . $server->uuid . '/backups'));
    }

    public function job(Request $request, string $short)
    {
        $this->findServer($request, $short);

        return response()->json(Client::get('/api/ext/job'));
    }

    public function restore(Request $request, string $short, int $backup)
    {
        $server = $this->findServer($request, $short);

        return response()->json(Client::post('/api/ext/backups/' . $backup . '/restore', [
            'wipe' => (bool) $request->input('wipe'),
            'expected_uuid' => $server->uuid, // el sistema rechaza copias de otros servidores
        ]));
    }

    public function download(Request $request, string $short, int $backup)
    {
        $server = $this->findServer($request, $short);
        $info = Client::get('/api/ext/backups/' . $backup);
        abort_if(empty($info['ok']), 404);
        abort_if(($info['backup']['server_uuid'] ?? '') !== $server->uuid, 403, 'Esta copia no pertenece a tu servidor.');

        $filename = $info['backup']['filename'] ?? ('copia-' . $backup . '.zip');
        $res = Client::stream('/api/ext/backups/' . $backup . '/download');
        abort_if($res->getStatusCode() !== 200, 404);

        return response()->streamDownload(function () use ($res) {
            $body = $res->getBody();
            while (!$body->eof()) {
                echo $body->read(131072);
                if (connection_aborted()) {
                    break;
                }
                flush();
            }
        }, $filename, ['Content-Type' => 'application/zip']);
    }
}
