import { BaseService } from '#src/services/base.service';

export class FilesService extends BaseService {
  readonly exists = this.filesRepository.existsSync;

  readonly read = this.filesRepository.readFileSync;

  readonly list = this.filesRepository.readdirSync;

  readonly remove = this.filesRepository.rmSync;

  readonly unlink = this.filesRepository.unlinkSync;

  readonly stat = this.filesRepository.statSync;

  readonly write = this.filesRepository.writeDurable;

  writeAsync(path: string, data: string | Uint8Array) {
    return this.filesRepository.writeDurableAsync(path, data, true);
  }

  readAsync(path: string) {
    return this.filesRepository.readAsync(path);
  }
}
