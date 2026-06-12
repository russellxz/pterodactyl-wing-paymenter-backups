<?php

namespace Pterodactyl\Http\Controllers\PteroBackups;

use Illuminate\Http\Request;
use Pterodactyl\Http\Controllers\Controller;
use Pterodactyl\PteroBackups\Client;

class AdminController extends Controller
{
    public function index()
    {
        return view('admin.pterobackups.index', [
            'configured' => Client::configured(),
            'settings' => Client::settings(),
        ]);
    }

    public function saveSettings(Request $request)
    {
        $request->validate([
            'url' => 'required|string|max:255',
            'api_key' => 'required|string|max:255',
        ]);
        Client::save($request->input('url'), $request->input('api_key'));

        $ping = Client::get('/api/ext/ping');
        if (!empty($ping['ok'])) {
            return redirect()->route('admin.pterobackups')
                ->with('pb_ok', 'Conexión correcta con ' . ($ping['name'] ?? 'PteroBackups') . ' v' . ($ping['version'] ?? '?') . '.');
        }

        return redirect()->route('admin.pterobackups')
            ->with('pb_err', 'Datos guardados, pero no se pudo conectar: ' . ($ping['message'] ?? 'revisa la URL y la clave.'));
    }

    // ----- Proxy JSON hacia el sistema de copias (solo admins raíz) -----

    public function overview()
    {
        return response()->json(Client::get('/api/ext/overview'));
    }

    public function job()
    {
        return response()->json(Client::get('/api/ext/job'));
    }

    public function cancel()
    {
        return response()->json(Client::post('/api/ext/job/cancel'));
    }

    public function run(Request $request)
    {
        return response()->json(Client::post('/api/ext/run', [
            'target' => (string) $request->input('target', 'both'),
            'node_id' => (int) $request->input('node_id', 0),
        ]));
    }

    public function nodeSnapshots(int $node)
    {
        return response()->json(Client::get('/api/ext/nodes/' . $node . '/snapshots'));
    }

    public function snapshot(int $snapshot)
    {
        return response()->json(Client::get('/api/ext/snapshots/' . $snapshot));
    }

    public function snapshotRestore(Request $request, int $snapshot)
    {
        return response()->json(Client::post('/api/ext/snapshots/' . $snapshot . '/restore', [
            'wipe' => (bool) $request->input('wipe'),
        ]));
    }

    public function snapshotDelete(int $snapshot)
    {
        return response()->json(Client::post('/api/ext/snapshots/' . $snapshot . '/delete'));
    }

    public function backupRestore(Request $request, int $backup)
    {
        return response()->json(Client::post('/api/ext/backups/' . $backup . '/restore', [
            'wipe' => (bool) $request->input('wipe'),
        ]));
    }

    public function backupDelete(int $backup)
    {
        return response()->json(Client::post('/api/ext/backups/' . $backup . '/delete'));
    }

    public function schedule()
    {
        return response()->json(Client::get('/api/ext/schedule'));
    }

    public function scheduleSave(Request $request)
    {
        return response()->json(Client::post('/api/ext/schedule', [
            'schedule_hours' => (string) $request->input('schedule_hours', '0'),
            'retention_hours' => (string) $request->input('retention_hours', '0'),
            'backup_target' => (string) $request->input('backup_target', 'both'),
        ]));
    }

    // ----- Descarga de cualquier copia (en streaming a través del panel) -----

    public function download(int $backup)
    {
        abort_unless(Client::configured(), 404);
        $info = Client::get('/api/ext/backups/' . $backup);
        abort_if(empty($info['ok']), 404, 'La copia no existe.');

        $filename = $info['backup']['filename'] ?? ('copia-' . $backup . '.zip');
        $res = Client::stream('/api/ext/backups/' . $backup . '/download');
        abort_if($res->getStatusCode() !== 200, 404, 'El archivo ya no existe.');

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
