"""Stylized cartoon street decor for the AgentWorld city.

Run:
    python tools/blender/decor.py --out apps/web/public/models/decor.glb [--preview DIR]

Contract with apps/web/src/world/worldAssets.ts:
  * One mesh node per kind/variant: `dec_TREE_0`, `dec_TREE_1`, `dec_TREE_2`, `dec_BUSH`,
    `dec_BENCH`, `dec_LAMP`, `dec_SIGN`, `dec_FOUNTAIN` (DecorKind in
    apps/web/src/world/types.ts). Origin on the ground; sized for scale 1.
  * Same encoding as buildings.glb: colours baked into COLOR_0, the outline hull merged
    with reversed winding, and no normals (the web computes flat normals).
  * Every instance is merged into a shared mesh on the web, so these stay very low-poly.
"""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import bpy  # noqa: E402

from common import MeshBuilder, arg, export_glb, hex_rgb, material, render_preview, reset_scene  # noqa: E402

OUTLINE = hex_rgb(0x2B2233)
OUTLINE_W = 0.05
LEAF, LEAF_DARK, LEAF_LIGHT, TRUNK = 0x6CC070, 0x4E9F5A, 0x9BD46E, 0x8A5A3B


def M(color: int) -> bpy.types.Material:
    return material(f"c_{color:06x}", hex_rgb(color))


def tree_round(b: MeshBuilder) -> None:
    b.cone(M(TRUNK), (0, 0, 0.9), 0.2, 0.26, 1.8, segments=6)
    b.sphere(M(LEAF), (0, 0, 2.9), (1.45, 1.45, 1.35), segments=9, rings=6)
    b.sphere(M(LEAF_LIGHT), (0.55, -0.45, 3.5), (0.75, 0.75, 0.7), segments=8, rings=5)
    b.sphere(M(LEAF_DARK), (-0.6, 0.35, 2.5), (0.8, 0.8, 0.7), segments=8, rings=5)


def tree_cone(b: MeshBuilder) -> None:
    b.cone(M(TRUNK), (0, 0, 0.6), 0.18, 0.22, 1.2, segments=6)
    for z, r, color in ((1.7, 1.5, LEAF_DARK), (2.7, 1.15, LEAF), (3.6, 0.8, LEAF_LIGHT)):
        b.cone(M(color), (0, 0, z), r, 0.05, 1.6, segments=7)


def tree_bushy(b: MeshBuilder) -> None:
    b.cone(M(TRUNK), (0, 0, 0.8), 0.22, 0.3, 1.6, segments=6)
    for (x, y, z, r, color) in ((0, 0, 2.6, 1.1, LEAF), (0.8, 0.2, 2.2, 0.85, LEAF_DARK),
                               (-0.75, -0.25, 2.3, 0.85, LEAF_LIGHT), (0.1, -0.1, 3.4, 0.8, LEAF_LIGHT)):
        b.sphere(M(color), (x, y, z), (r, r, r * 0.9), segments=8, rings=5)


def bush(b: MeshBuilder) -> None:
    b.sphere(M(LEAF), (0, 0, 0.6), (0.9, 0.9, 0.7), segments=8, rings=5)
    b.sphere(M(LEAF_LIGHT), (0.45, -0.25, 0.85), (0.5, 0.5, 0.45), segments=7, rings=4)
    b.sphere(M(0xF28BA8), (-0.3, -0.62, 0.9), (0.12, 0.12, 0.12), segments=6, rings=4)  # flower
    b.sphere(M(0xFFE08A), (0.3, -0.7, 0.6), (0.1, 0.1, 0.1), segments=6, rings=4)


def bench(b: MeshBuilder) -> None:
    for x in (-0.8, 0.8):
        b.box(M(0x55606E), (x, 0, 0.25), (0.12, 0.6, 0.5))
    for i in range(3):  # seat slats
        b.box(M(0xC98A4E), (0, -0.2 + i * 0.2, 0.55), (2.0, 0.16, 0.08))
    for i in range(2):  # back slats
        b.box(M(0xC98A4E), (0, 0.32, 0.8 + i * 0.22), (2.0, 0.06, 0.15))


def lamp(b: MeshBuilder) -> None:
    b.cone(M(0x3E4A5C), (0, 0, 0.15), 0.25, 0.22, 0.3, segments=8)
    b.cone(M(0x3E4A5C), (0, 0, 1.8), 0.07, 0.09, 3.2, segments=6)
    b.cone(M(0x3E4A5C), (0, 0, 3.55), 0.32, 0.12, 0.3, segments=8)
    b.sphere(M(0xFFE9A8), (0, 0, 3.3), (0.26, 0.26, 0.26), segments=8, rings=5)


def sign(b: MeshBuilder) -> None:
    b.box(M(0x6B5B4B), (0, 0, 0.75), (0.12, 0.12, 1.5))
    b.box(M(0x4F7CC2), (0, -0.07, 1.5), (0.95, 0.08, 0.58))
    b.box(M(0xFFFFFF), (0, -0.12, 1.5), (0.6, 0.02, 0.12))


def fountain(b: MeshBuilder) -> None:
    b.cone(M(0xD8D2C6), (0, 0, 0.35), 2.9, 2.6, 0.7, segments=14)
    b.cone(M(0x7CC7EE), (0, 0, 0.66), 2.5, 2.5, 0.06, segments=14)  # water
    b.cone(M(0xD8D2C6), (0, 0, 1.3), 0.35, 0.45, 1.6, segments=8)
    b.cone(M(0xD8D2C6), (0, 0, 2.1), 1.0, 0.6, 0.3, segments=10)
    b.sphere(M(0xA8E0F7), (0, 0, 2.45), (0.35, 0.35, 0.5), segments=8, rings=5)  # spout


KINDS = {
    "dec_TREE_0": tree_round, "dec_TREE_1": tree_cone, "dec_TREE_2": tree_bushy,
    "dec_BUSH": bush, "dec_BENCH": bench, "dec_LAMP": lamp, "dec_SIGN": sign, "dec_FOUNTAIN": fountain,
}


def main() -> None:
    out = arg("out", "apps/web/public/models/decor.glb")
    preview = arg("preview")
    reset_scene()
    objects = []
    for name, make in KINDS.items():
        b = MeshBuilder()
        b.smooth = False
        make(b)
        objects.append(b.build_vertex_colored(name, OUTLINE, OUTLINE_W))
    if preview:
        os.makedirs(preview, exist_ok=True)
        for i, obj in enumerate(objects):
            obj.location.x = (i - len(objects) / 2) * 4.0
        render_preview(os.path.join(preview, "decor.png"), target=(0, 0, 1.5), distance=30, angles=(0.0,), height=6)
        for obj in objects:
            obj.location.x = 0
    export_glb(out, vertex_colors=True, normals=False)
    print(f"exported {out} ({os.path.getsize(out) / 1024:.0f} KiB)")
    for obj in objects:
        print(f"  {obj.name}: {sum(len(p.vertices) - 2 for p in obj.data.polygons)} tris")


if __name__ == "__main__":
    main()
