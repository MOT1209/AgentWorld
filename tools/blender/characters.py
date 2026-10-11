"""Stylized chibi character for the AgentWorld 3D city.

Run (Blender as a Python module):
    python tools/blender/characters.py --out apps/web/public/models/character.glb [--preview DIR]
or inside Blender:
    blender -b -P tools/blender/characters.py -- --out ...

Contract with apps/web/src/world/characterAssets.ts:
  * Empties named `torso`, `head`, `armL`, `armR`, `legL`, `legR` are the animation pivots
    (same hierarchy and roles as the procedural builder: legs and torso hang off the hips,
    arms and head off the torso).
  * The upper-body mesh is named `chest` (the web app widens it per build variant).
  * Hairstyles are sibling meshes `hair_0` … `hair_3` under `head`; the app shows one.
  * Material roles: skin, hair, top, bottom, shoes, eye, white, blush, accent, outline.
  * `*__outline` meshes are inverted hulls (render back faces only, unlit, dark).
Dimensions are in character units; the app scales the whole figure by CHARACTER_SCALE.
"""
from __future__ import annotations

import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import bpy  # noqa: E402

from common import MeshBuilder, arg, empty, export_glb, hex_rgb, material, render_preview, reset_scene  # noqa: E402

# Pivot heights (character units). Chibi proportions: short legs, big head.
HIP_Z = 0.5
SHOULDER_Z = 0.42  # relative to the torso pivot
NECK_Z = 0.5  # relative to the torso pivot
HEAD_R = (0.3, 0.28, 0.29)  # x, y(depth), z
HEAD_C = 0.3  # head centre above the neck pivot
OUTLINE_W = 0.014


def materials() -> dict[str, bpy.types.Material]:
    return {
        "skin": material("skin", hex_rgb(0xF1C27D), 0.6),
        "hair": material("hair", hex_rgb(0x4A3426), 0.7),
        "top": material("top", hex_rgb(0x3B82F6), 0.8),
        "bottom": material("bottom", hex_rgb(0x334155), 0.85),
        "shoes": material("shoes", hex_rgb(0x2B2233), 0.6),
        "eye": material("eye", hex_rgb(0x1C1917), 0.3),
        "white": material("white", hex_rgb(0xFFFFFF), 0.2),
        "blush": material("blush", hex_rgb(0xF59E9E), 0.7),
        "accent": material("accent", hex_rgb(0xF8FAFC), 0.7),
        "outline": material("outline", hex_rgb(0x2B2233), 1.0),
    }


def face_y(x: float, z: float, lift: float = 0.0) -> float:
    """Y (front is negative) of the head surface at local (x, z), pushed out by `lift`."""
    rx, ry, rz = HEAD_R
    inside = 1.0 - (x / rx) ** 2 - ((z - HEAD_C) / rz) ** 2
    return -(ry * math.sqrt(max(inside, 0.0)) + lift)


def hair_cap(b: MeshBuilder, mat) -> None:
    """Skull cap that leaves the face open: keep the top and the back of a slightly larger sphere."""
    b.sphere(
        mat, (0, 0.012, HEAD_C + 0.02), (HEAD_R[0] + 0.022, HEAD_R[1] + 0.03, HEAD_R[2] + 0.025),
        segments=16, rings=10,
        keep=lambda x, y, z: z > 0.12 or (y > 0.15 and z > -0.55) or (abs(x) > 0.86 and z > -0.25),
    )


def build_hair(head, mats, outline) -> None:
    hair = mats["hair"]
    top = HEAD_C + HEAD_R[2]
    # 0 — tousled short with a three-lock fringe
    b = MeshBuilder()
    hair_cap(b, hair)
    for x, dz, r in ((-0.13, -0.05, 0.085), (0.0, -0.02, 0.095), (0.13, -0.06, 0.08)):
        b.sphere(hair, (x, face_y(x, top - 0.12 + dz, 0.0) + 0.02, top - 0.1 + dz), (r, r * 0.8, r * 0.9), segments=10, rings=7)
    b.build("hair_0", head, outline, OUTLINE_W)
    # 1 — cap + high bun
    b = MeshBuilder()
    hair_cap(b, hair)
    b.sphere(hair, (0, 0.1, top + 0.06), (0.12, 0.12, 0.11), segments=12, rings=8)
    b.sphere(hair, (0.0, face_y(0.0, top - 0.1) + 0.03, top - 0.08), (0.2, 0.07, 0.07), segments=12, rings=6)
    b.build("hair_1", head, outline, OUTLINE_W)
    # 2 — spiky
    b = MeshBuilder()
    hair_cap(b, hair)
    spikes = [(-0.16, -0.08, 0.5), (0.0, -0.12, 0.0), (0.16, -0.08, -0.5), (-0.1, 0.12, 0.6), (0.1, 0.12, -0.6), (0.0, 0.2, 0.0)]
    for x, y, tilt in spikes:
        b.cone(hair, (x, y, top + 0.04), 0.08, 0.0, 0.2, segments=8, rotation=(-0.5 if y < 0 else 0.5, tilt, 0.0))
    b.build("hair_2", head, outline, OUTLINE_W)
    # 3 — side part with long side locks
    b = MeshBuilder()
    hair_cap(b, hair)
    b.sphere(hair, (0.08, face_y(0.08, top - 0.1) + 0.03, top - 0.07), (0.22, 0.07, 0.08), segments=12, rings=6, rotation=(0, 0.25, 0))
    for side in (-1, 1):
        b.capsule(hair, (side * 0.27, 0.04, HEAD_C - 0.06), 0.075, 0.42, segments=10)
    b.sphere(hair, (0, 0.16, HEAD_C - 0.05), (0.27, 0.13, 0.25), segments=14, rings=8)
    b.build("hair_3", head, outline, OUTLINE_W)


def build(mats) -> bpy.types.Object:
    outline = mats["outline"]
    face_only = (mats["eye"], mats["white"], mats["blush"])
    root = empty("Character", (0, 0, 0))

    # Legs: hip pivots; the leg hangs down to the ground (z=0).
    for name, x in (("legL", -0.11), ("legR", 0.11)):
        pivot = empty(name, (x, 0, HIP_Z), root)
        b = MeshBuilder()
        b.capsule(mats["bottom"], (0, 0, -0.2), 0.085, 0.44)
        b.box(mats["shoes"], (0, -0.035, -0.44), (0.16, 0.25, 0.11), bevel=0.04)
        b.build(f"{name}_mesh", pivot, outline, OUTLINE_W)

    # Upper body: pivot at the hips (the walk cycle bobs/leans it).
    torso = empty("torso", (0, 0, HIP_Z), root)
    b = MeshBuilder()
    b.capsule(mats["top"], (0, 0, 0.27), 0.215, 0.44, segments=16, scale=(1.0, 0.86))
    b.capsule(mats["bottom"], (0, 0, 0.07), 0.205, 0.2, segments=16, scale=(1.0, 0.86))
    b.torus(mats["shoes"], (0, 0, 0.13), 0.2, 0.022, segments=20, ring=6)  # belt
    b.torus(mats["accent"], (0, -0.02, 0.47), 0.095, 0.032, segments=16, ring=6)  # collar
    b.build("chest", torso, outline, OUTLINE_W)

    for name, side in (("armL", -1), ("armR", 1)):
        pivot = empty(name, (side * 0.255, 0, SHOULDER_Z), torso)
        b = MeshBuilder()
        b.sphere(mats["top"], (0, 0, 0), (0.08, 0.08, 0.08), segments=10, rings=7)  # shoulder
        b.capsule(mats["top"], (0, 0, -0.15), 0.066, 0.3, segments=10)
        b.sphere(mats["skin"], (0, 0, -0.34), (0.072, 0.072, 0.075), segments=10, rings=7)
        b.build(f"{name}_mesh", pivot, outline, OUTLINE_W)

    # Head: pivot at the neck.
    head = empty("head", (0, 0, NECK_Z), torso)
    b = MeshBuilder()
    b.capsule(mats["skin"], (0, 0, 0.02), 0.07, 0.12, segments=10)  # neck
    b.sphere(mats["skin"], (0, 0, HEAD_C), HEAD_R, segments=20, rings=12)
    for side in (-1, 1):
        b.sphere(mats["skin"], (side * 0.295, 0.0, HEAD_C - 0.01), (0.05, 0.035, 0.065), segments=8, rings=6)  # ears
        ex, ez = side * 0.11, HEAD_C - 0.01
        b.sphere(mats["eye"], (ex, face_y(ex, ez, -0.012), ez), (0.042, 0.03, 0.058), segments=12, rings=8)
        hx, hz = side * 0.11 + 0.014, ez + 0.022
        b.sphere(mats["white"], (hx, face_y(hx, hz, 0.012), hz), (0.015, 0.012, 0.015), segments=8, rings=6)
        bx, bz = side * 0.17, HEAD_C - 0.085
        b.sphere(mats["blush"], (bx, face_y(bx, bz, -0.004), bz), (0.048, 0.012, 0.026), segments=10, rings=6)
        wx, wz = side * 0.11, HEAD_C + 0.085
        b.box(mats["hair"], (wx, face_y(wx, wz, 0.004), wz), (0.07, 0.02, 0.018), bevel=0.006, rotation=(0, side * -0.18, 0))
    mz = HEAD_C - 0.1
    b.torus(mats["eye"], (0, face_y(0, mz, 0.0), mz), 0.035, 0.009, arc=math.pi, segments=10, ring=5,
            rotation=(math.pi / 2, math.pi, 0))  # smile
    b.build("head_mesh", head, outline, OUTLINE_W, outline_skip=face_only)
    build_hair(head, mats, outline)
    return root


def main() -> None:
    out = arg("out", "apps/web/public/models/character.glb")
    preview = arg("preview")
    reset_scene()
    mats = materials()
    build(mats)
    if preview:
        os.makedirs(preview, exist_ok=True)
        for style in range(4):
            for obj in bpy.data.objects:
                if obj.name.startswith("hair_"):
                    obj.hide_render = not obj.name.startswith(f"hair_{style}")
                if obj.name.endswith("__outline"):
                    obj.hide_render = True  # Cycles has no back-face culling; the web renders these back-face only
            render_preview(os.path.join(preview, f"character_hair{style}.png"), angles=(0.0, 0.7))
        for obj in bpy.data.objects:
            obj.hide_render = False
    export_glb(out)
    tris = sum(len(p.vertices) - 2 for o in bpy.data.objects if o.type == "MESH" for p in o.data.polygons)
    print(f"exported {out} ({os.path.getsize(out) / 1024:.0f} KiB, {tris} tris incl. all hair variants and outlines)")


if __name__ == "__main__":
    main()
