import * as path from 'node:path';

export interface RecordingPathMove { source: string; destination: string }
export function relocateRecordingPath(file: string, moves: readonly RecordingPathMove[]): string {
    const normalize = (value: string): string => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
    const target = normalize(file);
    return moves.find(move => normalize(move.source) === target)?.destination ?? file;
}
