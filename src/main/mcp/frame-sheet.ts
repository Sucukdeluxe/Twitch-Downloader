export interface SheetCell { rgb: Buffer | null; label: string }
export interface SheetGeometry { columns: number; frameWidth: number; frameHeight: number; rowsPerSheet: number; framesPerSheet: number }
export interface ComposedSheet { width: number; height: number; rgb: Buffer }

export const SHEET_MAX_EDGE = 1536;
export const MIN_SHEET_COLUMNS = 1;
export const MAX_SHEET_COLUMNS = 8;
export const MAX_SHEET_ROWS = 10;

const GAP = 2;
const BACKGROUND = 18;
const TEXT_COLOR = 240;
const GLYPH_WIDTH = 5;
const GLYPH_HEIGHT = 7;
const GLYPHS: Record<string, readonly string[]> = {
    '0': ['.###.', '#...#', '#..##', '#.#.#', '##..#', '#...#', '.###.'],
    '1': ['..#..', '.##..', '..#..', '..#..', '..#..', '..#..', '.###.'],
    '2': ['.###.', '#...#', '....#', '...#.', '..#..', '.#...', '#####'],
    '3': ['#####', '...#.', '..#..', '...#.', '....#', '#...#', '.###.'],
    '4': ['...#.', '..##.', '.#.#.', '#..#.', '#####', '...#.', '...#.'],
    '5': ['#####', '#....', '####.', '....#', '....#', '#...#', '.###.'],
    '6': ['..##.', '.#...', '#....', '####.', '#...#', '#...#', '.###.'],
    '7': ['#####', '....#', '...#.', '..#..', '.#...', '.#...', '.#...'],
    '8': ['.###.', '#...#', '#...#', '.###.', '#...#', '#...#', '.###.'],
    '9': ['.###.', '#...#', '#...#', '.####', '....#', '...#.', '.##..'],
    ':': ['.....', '..#..', '..#..', '.....', '..#..', '..#..', '.....'],
    '.': ['.....', '.....', '.....', '.....', '.....', '..#..', '..#..'],
    '-': ['.....', '.....', '.....', '#####', '.....', '.....', '.....'],
    ' ': ['.....', '.....', '.....', '.....', '.....', '.....', '.....'],
};

export function sheetGeometry(columns: number): SheetGeometry {
    const count = Math.max(MIN_SHEET_COLUMNS, Math.min(MAX_SHEET_COLUMNS, Math.floor(columns) || MIN_SHEET_COLUMNS));
    const frameWidth = Math.floor((SHEET_MAX_EDGE - (count - 1) * GAP) / count / 2) * 2;
    const frameHeight = Math.round(frameWidth * 9 / 16 / 2) * 2;
    const rowsPerSheet = Math.max(1, Math.min(MAX_SHEET_ROWS, Math.floor((SHEET_MAX_EDGE + GAP) / (frameHeight + labelStripHeight(frameWidth) + GAP))));
    return { columns: count, frameWidth, frameHeight, rowsPerSheet, framesPerSheet: count * rowsPerSheet };
}

function labelScale(frameWidth: number): number {
    return frameWidth >= 480 ? 3 : 2;
}

export function labelStripHeight(frameWidth: number): number {
    return GLYPH_HEIGHT * labelScale(frameWidth) + 6;
}

function setPixel(buffer: Buffer, bufferWidth: number, x: number, y: number, value: number): void {
    const offset = (y * bufferWidth + x) * 3;
    if (x < 0 || x >= bufferWidth || offset < 0 || offset + 2 >= buffer.length) return;
    buffer[offset] = value;
    buffer[offset + 1] = value;
    buffer[offset + 2] = value;
}

export function drawText(buffer: Buffer, bufferWidth: number, left: number, top: number, text: string, scale: number): void {
    let x = left;
    for (const character of text) {
        const glyph = GLYPHS[character] ?? GLYPHS['-'];
        for (let row = 0; row < GLYPH_HEIGHT; row++) {
            for (let column = 0; column < GLYPH_WIDTH; column++) {
                if (glyph[row][column] !== '#') continue;
                for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) setPixel(buffer, bufferWidth, x + column * scale + dx, top + row * scale + dy, TEXT_COLOR);
            }
        }
        x += (GLYPH_WIDTH + 1) * scale;
    }
}

export function composeSheet(cells: SheetCell[], geometry: Pick<SheetGeometry, 'columns' | 'frameWidth' | 'frameHeight'>): ComposedSheet {
    const { columns, frameWidth, frameHeight } = geometry;
    const strip = labelStripHeight(frameWidth), scale = labelScale(frameWidth);
    const usedColumns = Math.max(1, Math.min(columns, cells.length));
    const rows = Math.max(1, Math.ceil(cells.length / columns));
    const width = usedColumns * frameWidth + (usedColumns - 1) * GAP;
    const height = rows * (frameHeight + strip) + (rows - 1) * GAP;
    const rgb = Buffer.alloc(width * height * 3, BACKGROUND);
    const frameBytes = frameWidth * frameHeight * 3;
    for (const [index, cell] of cells.entries()) {
        const left = (index % columns) * (frameWidth + GAP), top = Math.floor(index / columns) * (frameHeight + strip + GAP);
        if (cell.rgb && cell.rgb.length === frameBytes) {
            for (let row = 0; row < frameHeight; row++) cell.rgb.copy(rgb, ((top + row) * width + left) * 3, row * frameWidth * 3, (row + 1) * frameWidth * 3);
        }
        drawText(rgb, width, left + 4, top + frameHeight + 3, cell.rgb && cell.rgb.length === frameBytes ? cell.label : cell.label + ' -', scale);
    }
    return { width, height, rgb };
}

export function cropCells(sprite: Buffer, spriteWidth: number, columns: number, cellWidth: number, cellHeight: number, count: number): Array<Buffer | null> {
    const spriteHeight = sprite.length / 3 / spriteWidth;
    return Array.from({ length: count }, (_, index) => {
        const left = (index % columns) * cellWidth, top = Math.floor(index / columns) * cellHeight;
        if (!Number.isInteger(spriteHeight) || left + cellWidth > spriteWidth || top + cellHeight > spriteHeight) return null;
        const cell = Buffer.allocUnsafe(cellWidth * cellHeight * 3);
        for (let row = 0; row < cellHeight; row++) sprite.copy(cell, row * cellWidth * 3, ((top + row) * spriteWidth + left) * 3, ((top + row) * spriteWidth + left + cellWidth) * 3);
        return cell;
    });
}

export function scanTimes(from: number, to: number, intervalSeconds: number, maximum: number): { times: number[]; nextFrom: number | null } {
    const times: number[] = [];
    const step = Math.round(intervalSeconds * 1000), start = Math.round(from * 1000), end = Math.round(to * 1000);
    let position = start;
    while (position < end && times.length < maximum) {
        times.push(position / 1000);
        position += step;
    }
    return { times, nextFrom: position < end ? position / 1000 : null };
}
