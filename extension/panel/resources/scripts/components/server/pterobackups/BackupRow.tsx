import React from 'react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faArchive, faDownload, faHistory } from '@fortawesome/free-solid-svg-icons';
import tw from 'twin.macro';
import GreyRowBox from '@/components/elements/GreyRowBox';
import { RemoteBackup, backupsEndpoint } from '@/api/server/pterobackups/getServerBackups';
import { bytesToString } from '@/lib/formatters';

interface Props {
    uuid: string;
    backup: RemoteBackup;
    disabled: boolean;
    onRestore: (backup: RemoteBackup) => void;
    className?: string;
}

export default ({ uuid, backup, disabled, onRestore, className }: Props) => {
    return (
        <GreyRowBox $hoverable={false} className={className} css={tw`mb-2`}>
            <div css={tw`hidden md:block`}>
                <FontAwesomeIcon icon={faArchive} fixedWidth />
            </div>
            <div css={tw`flex-1 md:ml-4`}>
                <p css={tw`text-lg`}>{backup.date}</p>
                <p css={tw`text-xs text-neutral-400 mt-1`}>{bytesToString(backup.size)}</p>
            </div>
            <div css={tw`mt-4 md:mt-0 md:ml-4 flex`}>
                <a
                    css={tw`inline-flex items-center px-4 py-2 mr-2 rounded text-sm text-neutral-200 bg-neutral-600 hover:bg-neutral-500`}
                    href={`${backupsEndpoint(uuid)}/download/${backup.id}`}
                >
                    <FontAwesomeIcon icon={faDownload} css={tw`mr-2`} fixedWidth />
                    Download
                </a>
                <button
                    type={'button'}
                    disabled={disabled}
                    onClick={() => onRestore(backup)}
                    css={[
                        tw`inline-flex items-center px-4 py-2 rounded text-sm text-neutral-200 bg-yellow-600`,
                        disabled ? tw`opacity-50 cursor-not-allowed` : tw`hover:bg-yellow-500`,
                    ]}
                >
                    <FontAwesomeIcon icon={faHistory} css={tw`mr-2`} fixedWidth />
                    Restore
                </button>
            </div>
        </GreyRowBox>
    );
};
