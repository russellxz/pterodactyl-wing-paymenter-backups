<?php

namespace Pterodactyl\PteroBackups;

use GuzzleHttp\Client as Guzzle;
use Illuminate\Support\Facades\DB;

/**
 * Cliente de la extensión PteroBackups.
 *
 * La URL y la clave de API se guardan en la tabla `settings` de la base de
 * datos del panel: si reinstalas el panel con la misma BD, la extensión
 * vuelve a conectar sola en cuanto reinstalas estos archivos.
 */
class Client
{
    public static function settings(): array
    {
        $rows = DB::table('settings')
            ->whereIn('key', ['pterobackups::url', 'pterobackups::api_key'])
            ->pluck('value', 'key');

        return [
            'url' => rtrim((string) ($rows['pterobackups::url'] ?? ''), '/'),
            'key' => (string) ($rows['pterobackups::api_key'] ?? ''),
        ];
    }

    public static function configured(): bool
    {
        $s = self::settings();

        return $s['url'] !== '' && $s['key'] !== '';
    }

    public static function save(string $url, string $key): void
    {
        $values = [
            'pterobackups::url' => rtrim(trim($url), '/'),
            'pterobackups::api_key' => trim($key),
        ];
        foreach ($values as $k => $v) {
            DB::table('settings')->updateOrInsert(['key' => $k], ['value' => $v]);
        }
    }

    protected static function http(int $timeout = 30): Guzzle
    {
        $s = self::settings();

        return new Guzzle([
            'base_uri' => $s['url'],
            'timeout' => $timeout,
            'headers' => [
                'Authorization' => 'Bearer ' . $s['key'],
                'Accept' => 'application/json',
            ],
            'http_errors' => false,
        ]);
    }

    public static function get(string $path, array $query = []): array
    {
        try {
            $res = self::http()->get($path, ['query' => $query]);
            $data = json_decode((string) $res->getBody(), true);

            return is_array($data)
                ? $data
                : ['ok' => false, 'message' => 'Respuesta inválida del sistema (HTTP ' . $res->getStatusCode() . ').'];
        } catch (\Throwable $e) {
            return ['ok' => false, 'message' => 'No se pudo conectar con el sistema de copias: ' . $e->getMessage()];
        }
    }

    public static function post(string $path, array $data = []): array
    {
        try {
            $res = self::http(120)->post($path, ['json' => $data]);
            $json = json_decode((string) $res->getBody(), true);

            return is_array($json)
                ? $json
                : ['ok' => false, 'message' => 'Respuesta inválida del sistema (HTTP ' . $res->getStatusCode() . ').'];
        } catch (\Throwable $e) {
            return ['ok' => false, 'message' => 'No se pudo conectar con el sistema de copias: ' . $e->getMessage()];
        }
    }

    /**
     * Descarga en streaming (para los .zip grandes).
     */
    public static function stream(string $path)
    {
        return self::http(0)->get($path, ['stream' => true]);
    }
}
