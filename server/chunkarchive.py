"""Immutable storage for content-hashed front-end chunks."""
import settings
import argparse
import errno
import fcntl
import hashlib
import json
import os
import re
import secrets
import stat
import sys
from collections.abc import Mapping
from pathlib import Path


HERE = settings.STATE_DIR
DEFAULT_ARCHIVE_ROOT = HERE / "chunk-archive"
MANIFEST_NAME = "manifest.json"
NAME_RE = re.compile(r"^[A-Za-z0-9_.-]+\.[0-9a-f]{6,10}\.(?:js|css)$")
CHUNK_NAME_RE = NAME_RE
DEFAULT_ROOT = DEFAULT_ARCHIVE_ROOT
MAX_CHUNK_BYTES = 64 * 1024 * 1024
MAX_MANIFEST_BYTES = 4 * 1024 * 1024
_MD5_RE = re.compile(r"^[0-9a-f]{32}$")
_NOFOLLOW = getattr(os, "O_NOFOLLOW", 0)
_DIRECTORY = getattr(os, "O_DIRECTORY", 0)
_CLOEXEC = getattr(os, "O_CLOEXEC", 0)


class ArchiveError(RuntimeError):
    pass


def _md5(data):
    return hashlib.md5(data).hexdigest()


def _stat_key(value):
    return (
        value.st_dev,
        value.st_ino,
        value.st_mode,
        value.st_size,
        value.st_mtime_ns,
        value.st_ctime_ns,
    )


def _same_inode(left, right):
    return left[:2] == right[:2]


def _validate_name(name):
    if not isinstance(name, str):
        raise ArchiveError("chunk name must be text")
    if "\x00" in name or "/" in name or "\\" in name or name in (".", ".."):
        raise ArchiveError(f"unsafe chunk name: {name!r}")
    if NAME_RE.fullmatch(name) is None:
        raise ArchiveError(f"invalid chunk name: {name!r}")
    return name


def valid_name(name):
    try:
        _validate_name(name)
        return True
    except ArchiveError:
        return False


def _validate_md5(value, label):
    if not isinstance(value, str) or _MD5_RE.fullmatch(value) is None:
        raise ArchiveError(f"invalid md5 for {label}")
    return value


def _cohort(names, expected):
    if isinstance(names, (str, bytes)):
        raise ArchiveError("chunk names must be an iterable of names")
    try:
        clean = [_validate_name(name) for name in names]
    except TypeError as exc:
        raise ArchiveError("chunk names must be iterable") from exc
    if not clean:
        raise ArchiveError("chunk cohort must not be empty")
    if len(clean) != len(set(clean)):
        raise ArchiveError("chunk cohort contains duplicate names")

    expected = {} if expected is None else expected
    if not isinstance(expected, Mapping):
        raise ArchiveError("expected hashes must be a mapping")
    checked = {}
    for name, digest in expected.items():
        name = _validate_name(name)
        if name not in clean:
            raise ArchiveError(f"expected hash names a chunk outside the cohort: {name}")
        checked[name] = _validate_md5(digest, name)
    return clean, checked


def _reject_symlink_components(path, label, missing_leaf_ok=False):
    path = Path(path)
    current = Path(path.anchor)
    for part in path.parts[1:]:
        current /= part
        try:
            value = os.lstat(current)
        except FileNotFoundError:
            if missing_leaf_ok and current == path:
                return
            raise ArchiveError(f"{label} does not exist")
        except (OSError, ValueError) as exc:
            raise ArchiveError(f"cannot inspect {label}: {exc}") from exc
        if stat.S_ISLNK(value.st_mode):
            raise ArchiveError(f"{label} must not contain a symlink")


def _fsync_parent(path, label):
    try:
        fd = os.open(path.parent, os.O_RDONLY | _DIRECTORY | _NOFOLLOW | _CLOEXEC)
    except OSError as exc:
        raise ArchiveError(f"cannot open parent of {label}: {exc}") from exc
    try:
        os.fsync(fd)
    except OSError as exc:
        raise ArchiveError(f"cannot sync parent of {label}: {exc}") from exc
    finally:
        os.close(fd)


def _open_directory(path, label, create=False):
    _reject_symlink_components(path, label, missing_leaf_ok=create)
    created = False
    try:
        before = os.lstat(path)
    except FileNotFoundError:
        if not create:
            raise ArchiveError(f"{label} does not exist")
        try:
            os.mkdir(path, 0o755)
            created = True
        except FileExistsError:
            pass
        except OSError as exc:
            raise ArchiveError(f"cannot create {label}: {exc}") from exc
        try:
            before = os.lstat(path)
        except OSError as exc:
            raise ArchiveError(f"cannot inspect {label}: {exc}") from exc
    except (OSError, ValueError) as exc:
        raise ArchiveError(f"cannot inspect {label}: {exc}") from exc

    if stat.S_ISLNK(before.st_mode):
        raise ArchiveError(f"{label} must not be a symlink")
    if not stat.S_ISDIR(before.st_mode):
        raise ArchiveError(f"{label} must be a directory")

    try:
        fd = os.open(path, os.O_RDONLY | _DIRECTORY | _NOFOLLOW | _CLOEXEC)
    except (OSError, ValueError) as exc:
        raise ArchiveError(f"cannot open {label}: {exc}") from exc
    after = os.fstat(fd)
    if not stat.S_ISDIR(after.st_mode) or (
        before.st_dev,
        before.st_ino,
    ) != (
        after.st_dev,
        after.st_ino,
    ):
        os.close(fd)
        raise ArchiveError(f"{label} changed while opening")
    if created:
        _fsync_parent(Path(path), label)
    return fd


def _stat_regular_at(dir_fd, name, label, missing_ok=False, max_bytes=MAX_CHUNK_BYTES):
    try:
        value = os.stat(name, dir_fd=dir_fd, follow_symlinks=False)
    except FileNotFoundError:
        if missing_ok:
            return None
        raise ArchiveError(f"{label} does not exist")
    except OSError as exc:
        raise ArchiveError(f"cannot inspect {label}: {exc}") from exc

    if stat.S_ISLNK(value.st_mode):
        raise ArchiveError(f"{label} must not be a symlink")
    if not stat.S_ISREG(value.st_mode):
        raise ArchiveError(f"{label} must be a regular file")
    if value.st_size < 0 or value.st_size > max_bytes:
        raise ArchiveError(f"{label} exceeds the size limit")
    return value


def _read_regular_at(dir_fd, name, label, missing_ok=False, max_bytes=MAX_CHUNK_BYTES):
    before = _stat_regular_at(dir_fd, name, label, missing_ok, max_bytes)
    if before is None:
        return None

    try:
        fd = os.open(name, os.O_RDONLY | _NOFOLLOW | _CLOEXEC, dir_fd=dir_fd)
    except OSError as exc:
        raise ArchiveError(f"cannot open {label}: {exc}") from exc
    try:
        opened = os.fstat(fd)
        if _stat_key(opened) != _stat_key(before):
            raise ArchiveError(f"{label} changed while opening")
        remaining = opened.st_size
        parts = []
        while remaining:
            part = os.read(fd, min(1024 * 1024, remaining))
            if not part:
                raise ArchiveError(f"{label} changed while reading")
            parts.append(part)
            remaining -= len(part)
        if os.read(fd, 1):
            raise ArchiveError(f"{label} changed while reading")
        after = os.fstat(fd)
        if _stat_key(after) != _stat_key(opened):
            raise ArchiveError(f"{label} changed while reading")
        try:
            data = b"".join(parts)
        except MemoryError as exc:
            raise ArchiveError(f"cannot read {label}") from exc
        return data, _stat_key(after)
    finally:
        os.close(fd)


def _unique_object(pairs):
    value = {}
    for key, item in pairs:
        if key in value:
            raise ArchiveError(f"archive manifest has duplicate key: {key}")
        value[key] = item
    return value


def _load_manifest(root_fd):
    hit = _read_regular_at(
        root_fd,
        MANIFEST_NAME,
        "archive manifest",
        missing_ok=True,
        max_bytes=MAX_MANIFEST_BYTES,
    )
    if hit is None:
        return {}, None
    data, signature = hit
    try:
        manifest = json.loads(data.decode("utf-8"), object_pairs_hook=_unique_object)
    except ArchiveError:
        raise
    except (UnicodeDecodeError, json.JSONDecodeError, RecursionError, ValueError) as exc:
        raise ArchiveError("archive manifest is not valid JSON") from exc
    if not isinstance(manifest, dict):
        raise ArchiveError("archive manifest must be a direct object")
    clean = {}
    for name, digest in manifest.items():
        name = _validate_name(name)
        clean[name] = _validate_md5(digest, name)
    return clean, signature


def _write_all(fd, data):
    view = memoryview(data)
    while view:
        written = os.write(fd, view)
        if written <= 0:
            raise OSError(errno.EIO, "short write")
        view = view[written:]


def _temp_name(prefix):
    return f".{prefix}-{os.getpid()}-{secrets.token_hex(8)}"


def _stage_bytes(root_fd, data, prefix, mode=0o644):
    name = _temp_name(prefix)
    try:
        fd = os.open(
            name,
            os.O_WRONLY | os.O_CREAT | os.O_EXCL | _NOFOLLOW | _CLOEXEC,
            0o600,
            dir_fd=root_fd,
        )
    except OSError as exc:
        raise ArchiveError(f"cannot stage archive data: {exc}") from exc
    try:
        _write_all(fd, data)
        os.fchmod(fd, mode)
        os.fsync(fd)
    except OSError as exc:
        try:
            os.unlink(name, dir_fd=root_fd)
        except OSError:
            pass
        raise ArchiveError(f"cannot stage archive data: {exc}") from exc
    finally:
        os.close(fd)
    return name


def _seal_and_sync_at(root_fd, name, signature, label):
    try:
        fd = os.open(name, os.O_RDONLY | _NOFOLLOW | _CLOEXEC, dir_fd=root_fd)
    except OSError as exc:
        raise ArchiveError(f"cannot open {label}: {exc}") from exc
    try:
        opened = os.fstat(fd)
        if _stat_key(opened) != signature:
            raise ArchiveError(f"{label} changed before adoption")
        os.fchmod(fd, 0o444)
        os.fsync(fd)
    except OSError as exc:
        raise ArchiveError(f"cannot sync {label}: {exc}") from exc
    finally:
        os.close(fd)


def _manifest_unchanged(root_fd, signature):
    try:
        current = os.stat(
            MANIFEST_NAME,
            dir_fd=root_fd,
            follow_symlinks=False,
        )
    except FileNotFoundError:
        if signature is not None:
            raise ArchiveError("archive manifest changed during update")
        return
    except OSError as exc:
        raise ArchiveError(f"cannot inspect archive manifest: {exc}") from exc
    if stat.S_ISLNK(current.st_mode):
        raise ArchiveError("archive manifest must not be a symlink")
    if not stat.S_ISREG(current.st_mode) or _stat_key(current) != signature:
        raise ArchiveError("archive manifest changed during update")


def _write_manifest(root_fd, manifest, previous_signature):
    payload = (json.dumps(manifest, sort_keys=True, indent=2) + "\n").encode("utf-8")
    temp = _stage_bytes(root_fd, payload, "chunk-manifest")
    try:
        os.fsync(root_fd)
        _manifest_unchanged(root_fd, previous_signature)
        os.replace(
            temp,
            MANIFEST_NAME,
            src_dir_fd=root_fd,
            dst_dir_fd=root_fd,
        )
        temp = None
        os.fsync(root_fd)
    except ArchiveError:
        raise
    except OSError as exc:
        raise ArchiveError(f"cannot publish archive manifest: {exc}") from exc
    finally:
        if temp is not None:
            try:
                os.unlink(temp, dir_fd=root_fd)
            except OSError:
                pass


def _read_source_cohort(source_fd, names, expected):
    snapshots = {}
    for name in names:
        value = _stat_regular_at(source_fd, name, f"source chunk {name}")
        snapshots[name] = _stat_key(value)

    sources = {}
    for name in names:
        data, signature = _read_regular_at(source_fd, name, f"source chunk {name}")
        if signature != snapshots[name]:
            raise ArchiveError(f"source chunk {name} changed during cohort read")
        digest = _md5(data)
        if name in expected and expected[name] != digest:
            raise ArchiveError(f"expected md5 mismatch for {name}")
        sources[name] = (data, digest, signature)
    _assert_sources_unchanged(source_fd, sources)
    return sources


def _assert_sources_unchanged(source_fd, sources):
    for name, (_, _, signature) in sources.items():
        current = _stat_regular_at(source_fd, name, f"source chunk {name}")
        if _stat_key(current) != signature:
            raise ArchiveError(f"source chunk {name} changed during cohort read")


class ChunkArchive:
    def __init__(self, archive_root=None):
        root = DEFAULT_ARCHIVE_ROOT if archive_root is None else archive_root
        self.root = Path(os.path.abspath(os.fspath(root)))
        self.manifest_path = self.root / MANIFEST_NAME

    def archive_cohort(self, source_dir, names, expected=None):
        names, expected = _cohort(names, expected)
        source_path = Path(os.path.abspath(os.fspath(source_dir)))
        source_fd = _open_directory(source_path, "source root")
        root_fd = None
        try:
            sources = _read_source_cohort(source_fd, names, expected)
            root_fd = _open_directory(self.root, "archive root", create=True)
            fcntl.flock(root_fd, fcntl.LOCK_EX)
            if _same_inode(_stat_key(os.fstat(source_fd)), _stat_key(os.fstat(root_fd))):
                raise ArchiveError("source root and archive root must differ")

            manifest, manifest_signature = _load_manifest(root_fd)
            to_install = []
            to_adopt = {}
            for name in names:
                data, digest, source_signature = sources[name]
                archived = _read_regular_at(
                    root_fd,
                    name,
                    f"archived chunk {name}",
                    missing_ok=True,
                )
                recorded = manifest.get(name)
                if archived is not None and _same_inode(archived[1], source_signature):
                    raise ArchiveError(f"source and destination share an inode for {name}")
                if recorded is not None:
                    if recorded != digest:
                        raise ArchiveError(f"manifest/source mismatch for {name}")
                    if archived is None:
                        raise ArchiveError(f"manifest destination missing for {name}")
                    if archived[0] != data:
                        raise ArchiveError(f"manifest/destination mismatch for {name}")
                elif archived is None:
                    to_install.append(name)
                elif archived[0] != data:
                    raise ArchiveError(f"source/destination mismatch for {name}")
                else:
                    to_adopt[name] = archived[1]

            _assert_sources_unchanged(source_fd, sources)
            for name, signature in to_adopt.items():
                _seal_and_sync_at(root_fd, name, signature, f"archived chunk {name}")

            stages = {}
            try:
                for name in to_install:
                    stages[name] = _stage_bytes(
                        root_fd,
                        sources[name][0],
                        "chunk-stage",
                        mode=0o444,
                    )
                if stages:
                    os.fsync(root_fd)

                for name in to_install:
                    temp = stages[name]
                    try:
                        os.link(
                            temp,
                            name,
                            src_dir_fd=root_fd,
                            dst_dir_fd=root_fd,
                            follow_symlinks=False,
                        )
                    except FileExistsError:
                        archived = _read_regular_at(
                            root_fd,
                            name,
                            f"archived chunk {name}",
                        )
                        if archived[0] != sources[name][0]:
                            raise ArchiveError(f"source/destination mismatch for {name}")
                        if _same_inode(archived[1], sources[name][2]):
                            raise ArchiveError(f"source and destination share an inode for {name}")
                        _seal_and_sync_at(
                            root_fd,
                            name,
                            archived[1],
                            f"archived chunk {name}",
                        )
                    except OSError as exc:
                        raise ArchiveError(f"cannot install archived chunk {name}: {exc}") from exc
                    os.unlink(temp, dir_fd=root_fd)
                    stages.pop(name, None)
                if to_install:
                    os.fsync(root_fd)

                _assert_sources_unchanged(source_fd, sources)
                for name in names:
                    archived = _read_regular_at(root_fd, name, f"archived chunk {name}")
                    if _same_inode(archived[1], sources[name][2]):
                        raise ArchiveError(f"source and destination share an inode for {name}")
                    if archived[0] != sources[name][0]:
                        raise ArchiveError(f"source/destination mismatch for {name}")
                    if _md5(archived[0]) != sources[name][1]:
                        raise ArchiveError(f"archive md5 mismatch for {name}")

                updated = dict(manifest)
                for name in names:
                    updated[name] = sources[name][1]
                if updated != manifest:
                    _write_manifest(root_fd, updated, manifest_signature)
            finally:
                for temp in stages.values():
                    try:
                        os.unlink(temp, dir_fd=root_fd)
                    except OSError:
                        pass
            return {name: sources[name][1] for name in names}
        except ArchiveError:
            raise
        except (OSError, ValueError, RecursionError) as exc:
            raise ArchiveError(f"archive update failed: {exc}") from exc
        finally:
            if root_fd is not None:
                try:
                    fcntl.flock(root_fd, fcntl.LOCK_UN)
                finally:
                    os.close(root_fd)
            os.close(source_fd)

    def lookup(self, name):
        try:
            name = _validate_name(name)
            root_fd = _open_directory(self.root, "archive root")
        except (ArchiveError, OSError, ValueError, RecursionError):
            return None
        try:
            fcntl.flock(root_fd, fcntl.LOCK_SH)
            manifest, _ = _load_manifest(root_fd)
            recorded = manifest.get(name)
            if recorded is None:
                return None
            archived = _read_regular_at(
                root_fd,
                name,
                f"archived chunk {name}",
                missing_ok=True,
            )
            if archived is None or _md5(archived[0]) != recorded:
                return None
            return self.root / name
        except (ArchiveError, OSError, ValueError, RecursionError):
            return None
        finally:
            try:
                fcntl.flock(root_fd, fcntl.LOCK_UN)
            finally:
                os.close(root_fd)

    def verify_cohort(self, names, expected=None):
        try:
            names, expected = _cohort(names, expected)
            root_fd = _open_directory(self.root, "archive root")
        except (ArchiveError, OSError, ValueError, RecursionError):
            return False
        try:
            fcntl.flock(root_fd, fcntl.LOCK_SH)
            manifest, _ = _load_manifest(root_fd)
            for name in names:
                recorded = manifest.get(name)
                if recorded is None:
                    return False
                if name in expected and expected[name] != recorded:
                    return False
                archived = _read_regular_at(
                    root_fd,
                    name,
                    f"archived chunk {name}",
                    missing_ok=True,
                )
                if archived is None or _md5(archived[0]) != recorded:
                    return False
            return True
        except (ArchiveError, OSError, ValueError, RecursionError):
            return False
        finally:
            try:
                fcntl.flock(root_fd, fcntl.LOCK_UN)
            finally:
                os.close(root_fd)

    def verify_source_cohort(self, source_dir, names):
        names, _ = _cohort(names, None)
        source_path = Path(os.path.abspath(os.fspath(source_dir)))
        source_fd = _open_directory(source_path, "source root")
        root_fd = None
        try:
            sources = _read_source_cohort(source_fd, names, {})
            root_fd = _open_directory(self.root, "archive root")
            fcntl.flock(root_fd, fcntl.LOCK_SH)
            if _same_inode(_stat_key(os.fstat(source_fd)), _stat_key(os.fstat(root_fd))):
                raise ArchiveError("source root and archive root must differ")
            manifest, _ = _load_manifest(root_fd)
            for name in names:
                data, digest, source_signature = sources[name]
                if manifest.get(name) != digest:
                    raise ArchiveError(f"source/manifest mismatch for {name}")
                archived = _read_regular_at(
                    root_fd,
                    name,
                    f"archived chunk {name}",
                    missing_ok=True,
                )
                if archived is None:
                    raise ArchiveError(f"manifest destination missing for {name}")
                if _same_inode(archived[1], source_signature):
                    raise ArchiveError(f"source and destination share an inode for {name}")
                if archived[0] != data or _md5(archived[0]) != digest:
                    raise ArchiveError(f"source/destination mismatch for {name}")
            _assert_sources_unchanged(source_fd, sources)
            return {name: sources[name][1] for name in names}
        except ArchiveError:
            raise
        except (OSError, ValueError, RecursionError) as exc:
            raise ArchiveError(f"archive verification failed: {exc}") from exc
        finally:
            if root_fd is not None:
                try:
                    fcntl.flock(root_fd, fcntl.LOCK_UN)
                finally:
                    os.close(root_fd)
            os.close(source_fd)

    def status(self):
        try:
            _reject_symlink_components(self.root, "archive root", missing_leaf_ok=True)
            try:
                os.lstat(self.root)
            except FileNotFoundError:
                return {"healthy": True, "entries": 0}
            root_fd = _open_directory(self.root, "archive root")
        except (ArchiveError, OSError, ValueError, RecursionError):
            return {"healthy": False, "entries": 0}
        try:
            fcntl.flock(root_fd, fcntl.LOCK_SH)
            manifest, _ = _load_manifest(root_fd)
            for name, recorded in manifest.items():
                archived = _read_regular_at(
                    root_fd,
                    name,
                    f"archived chunk {name}",
                    missing_ok=True,
                )
                if archived is None or _md5(archived[0]) != recorded:
                    return {"healthy": False, "entries": 0}
            return {"healthy": True, "entries": len(manifest)}
        except (ArchiveError, OSError, ValueError, RecursionError):
            return {"healthy": False, "entries": 0}
        finally:
            try:
                fcntl.flock(root_fd, fcntl.LOCK_UN)
            finally:
                os.close(root_fd)


def archive_cohort(source_dir, names, expected=None, archive_root=None):
    return ChunkArchive(archive_root).archive_cohort(source_dir, names, expected)


def lookup(name, archive_root=None):
    return ChunkArchive(archive_root).lookup(name)


def verify_cohort(names, expected=None, archive_root=None):
    return ChunkArchive(archive_root).verify_cohort(names, expected)


def verify_source_cohort(source_dir, names, archive_root=None):
    return ChunkArchive(archive_root).verify_source_cohort(source_dir, names)


def status(archive_root=None):
    return ChunkArchive(archive_root).status()


def _parser():
    parser = argparse.ArgumentParser(description="archive immutable front-end chunks")
    commands = parser.add_subparsers(dest="command", required=True)
    for command in ("archive", "verify"):
        sub = commands.add_parser(command)
        sub.add_argument("--source", required=True)
        sub.add_argument("--archive-root")
        sub.add_argument("names", nargs="+")
    return parser


def main(argv=None):
    args = _parser().parse_args(argv)
    store = ChunkArchive(args.archive_root)
    try:
        if args.command == "archive":
            result = store.archive_cohort(args.source, args.names)
            verb = "archived"
        else:
            result = store.verify_source_cohort(args.source, args.names)
            verb = "verified"
    except (ArchiveError, OSError, ValueError, RecursionError) as exc:
        print(f"chunkarchive: {exc}", file=sys.stderr)
        return 1
    noun = "chunk" if len(result) == 1 else "chunks"
    print(f"{verb} {len(result)} {noun}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
