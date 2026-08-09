<?php

namespace Pterodactyl\Console\Commands;

use Illuminate\Console\Command;
use Pterodactyl\Contracts\Repository\SettingsRepositoryInterface;

/**
 * Añade (o quita) el botón "Backup 2.0" en el menú lateral del tema Arix.
 *
 * Arix NO dibuja el menú del servidor a partir de resources/scripts/routers/routes.ts
 * como hace el panel normal: lo dibuja a partir de una lista de enlaces guardada
 * en la base de datos, en el ajuste `settings::arix:links` (es lo que edita el
 * admin en el panel de Arix). Por eso, para que el botón salga con Arix hay que
 * añadir la entrada ahí, no en routes.ts.
 *
 * La ventaja es que esta parte NO necesita recompilar el panel: en cuanto se
 * guarda el ajuste, el botón aparece.
 *
 * Uso:
 *   php artisan pterobackups:arix-link            -> añade el botón
 *   php artisan pterobackups:arix-link --remove   -> lo quita
 */
class PteroBackupsArixLinkCommand extends Command
{
    protected $signature = 'pterobackups:arix-link
        {--remove : Quita el botón del menú en vez de añadirlo}
        {--status : Solo informa de si el botón está puesto, sin tocar nada}';

    protected $description = 'Añade el botón "Backup 2.0" al menú lateral del tema Arix (o lo quita con --remove).';

    public const SETTING_KEY = 'settings::arix:links';
    public const LINK_URL = '/pterobackups';

    public function __construct(private SettingsRepositoryInterface $settings)
    {
        parent::__construct();
    }

    public function handle(): int
    {
        if (!$this->arixInstalled()) {
            $this->line('El tema Arix no está instalado: no hay nada que hacer.');

            return 0;
        }

        $raw = $this->settings->get(self::SETTING_KEY);
        if (empty($raw)) {
            // Arix todavía no ha guardado su configuración de enlaces (usa la de
            // por defecto, que está en su controlador). Si escribiéramos aquí una
            // lista propia nos cargaríamos su menú entero, así que mejor avisar.
            $this->warn('Arix aún no ha guardado su lista de enlaces.');
            $this->warn('Entra una vez a  /admin/arix  -> Links, pulsa Guardar, y vuelve a ejecutar este comando.');

            return 1;
        }

        $links = json_decode($raw, true);
        if (!is_array($links)) {
            $this->error('No se pudo leer la lista de enlaces de Arix (JSON inválido). No se ha tocado nada.');

            return 1;
        }

        if ($this->option('status')) {
            if ($this->hasLink($links)) {
                $this->info('El botón "Backup 2.0" ESTÁ en el menú de Arix.');

                return 0;
            }
            $this->warn('El botón "Backup 2.0" NO está en el menú de Arix.');

            return 1;
        }

        $links = $this->option('remove') ? $this->removeLink($links) : $this->addLink($links);
        if ($links === null) {
            return 0; // ya estaba como queríamos
        }

        $this->settings->set(self::SETTING_KEY, json_encode($links));
        $this->info($this->option('remove')
            ? 'Botón "Backup 2.0" retirado del menú de Arix.'
            : 'Botón "Backup 2.0" añadido al menú de Arix.');

        return 0;
    }

    private function arixInstalled(): bool
    {
        return is_dir(app_path('Http/Controllers/Admin/Arix')) || !empty(config('arixTheme'));
    }

    private function hasLink(array $links): bool
    {
        foreach ($links as $category) {
            foreach ($category['links'] ?? [] as $link) {
                if (($link['url'] ?? '') === self::LINK_URL) {
                    return true;
                }
            }
        }

        return false;
    }

    /**
     * Mete el enlace justo detrás del de "Backups" (o al final de la primera
     * categoría, si ese no existe). Es idempotente: si ya está, no hace nada.
     */
    private function addLink(array $links): ?array
    {
        if ($this->hasLink($links)) {
            $this->line('El botón ya estaba en el menú de Arix.');

            return null;
        }

        $entry = [
            'icon' => 'HiOutlineArchive',
            'name' => 'Backup 2.0',
            'url' => self::LINK_URL,
            'permission' => ['backup.*'],
            'nests' => [],
            'eggs' => [],
            'active' => true,
        ];

        // Preferimos colgarlo detrás del botón de copias que ya trae el panel.
        foreach ($links as $key => $category) {
            $items = $category['links'] ?? [];
            foreach ($items as $index => $link) {
                if (($link['url'] ?? '') === '/backups') {
                    array_splice($items, $index + 1, 0, [$entry]);
                    $links[$key]['links'] = $items;

                    return $links;
                }
            }
        }

        // Si no hay botón de copias, al final de la primera categoría.
        $first = array_key_first($links);
        if ($first === null) {
            $this->error('Arix no tiene ninguna categoría de enlaces. No se ha tocado nada.');

            return null;
        }
        $links[$first]['links'][] = $entry;

        return $links;
    }

    private function removeLink(array $links): ?array
    {
        $found = false;
        foreach ($links as $key => $category) {
            $items = array_values(array_filter(
                $category['links'] ?? [],
                function ($link) use (&$found) {
                    if (($link['url'] ?? '') === self::LINK_URL) {
                        $found = true;

                        return false;
                    }

                    return true;
                }
            ));
            $links[$key]['links'] = $items;
        }

        if (!$found) {
            $this->line('El botón no estaba en el menú de Arix.');

            return null;
        }

        return $links;
    }
}
