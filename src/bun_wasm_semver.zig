//! `bun.Semver` shim for wasm32-freestanding builds.
//!
//! Re-exports the pure semver types from src/semver/*.zig — explicitly
//! excluding SemverObject.zig which is entirely JSC-bound.
//!
//! Lives at src/ level so relative imports can reach src/semver/*.

pub const String = @import("./semver/SemverString.zig").String;
pub const ExternalString = @import("./semver/ExternalString.zig").ExternalString;
pub const Version = @import("./semver/Version.zig").Version;
pub const VersionType = @import("./semver/Version.zig").VersionType;
pub const SlicedString = @import("./semver/SlicedString.zig");
pub const Range = @import("./semver/SemverRange.zig");
pub const Query = @import("./semver/SemverQuery.zig");
// NOTE: SemverObject intentionally excluded — requires JSC bindings.
