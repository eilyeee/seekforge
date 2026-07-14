/** Compatibility facade for the server file-service modules. */

export {
  clearFilesCacheForTests,
  FILE_LIST_LIMIT,
  listWorkspaceFiles,
  searchWorkspaceContent,
  type FileList,
  type SearchHit,
  type SearchOptions,
  type SearchResult,
} from "./file-scan-search.js";
export {
  IMAGE_EXTENSIONS,
  MAX_RAW_BYTES,
  MAX_UPLOAD_BYTES,
  RawFileError,
  readRawUpload,
  saveUpload,
  UploadError,
} from "./file-upload-raw.js";
export {
  FileBrowseError,
  listTree,
  MAX_FILE_BYTES,
  readTextFile,
  writeTextFile,
  type FileView,
  type Tree,
  type TreeEntry,
} from "./file-browse-edit.js";
