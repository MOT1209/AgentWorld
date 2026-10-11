"""Stylized cartoon buildings for the AgentWorld city, one mesh per archetype.

Run:
    python tools/blender/buildings.py --out apps/web/public/models/buildings.glb [--preview DIR]

Contract with apps/web/src/world/worldAssets.ts:
  * One mesh node per archetype, named `bld_<ARCHETYPE>` (see BuildingArchetype in
    apps/web/src/world/types.ts), each built at that archetype's FOOTPRINT
    (apps/web/src/world/layout.ts): origin at the ground centre, walls to height h,
    front (door) facing -Y in Blender (= +Z on the web).
  * Colours are baked into the `Color` vertex attribute (exported as COLOR_0); the web
    tints per building with the material colour.
  * The outline is an inverted hull with reversed winding inside the same mesh, so a
    single front-face material draws building and outline in one call.
"""
from __future__ import annotations

import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import bpy  # noqa: E402

from common import MeshBuilder, arg, export_glb, hex_rgb, material, render_preview, reset_scene  # noqa: E402

# Keep in sync with FOOTPRINTS in apps/web/src/world/layout.ts.
FOOTPRINTS: dict[str, tuple[float, float, float]] = {
    "HOUSE": (9, 10, 3.6), "TOWNHOUSE": (8, 11, 7.2), "APARTMENT": (13, 11, 12.5),
    "SHOP": (12, 10, 4.6), "RESTAURANT": (12, 10, 4.6), "MARKET": (16, 12, 6.2),
    "OFFICE": (15, 12, 15.5), "HQ": (20, 14, 24), "BANK": (14, 12, 9.4), "CIVIC": (18, 13, 10.6),
    "SCHOOL": (20, 12, 8.2), "HOSPITAL": (18, 14, 14.4), "PARK_PAVILION": (10, 10, 4.2),
    "STATION": (16, 10, 6.4), "WAREHOUSE": (20, 16, 8.4), "GARAGE": (12, 10, 5),
    "BARN": (12, 10, 5.2), "CONTEXT_HOUSE": (8, 9, 3.4), "CONTEXT_BLOCK": (13, 11, 10.5),
    "CONTEXT_BARN": (11, 9, 4.6),
}

OUTLINE = hex_rgb(0x2B2233)
OUTLINE_W = 0.1

# Cartoon palette (sRGB hex).
CREAM, PEACH, BRICK, SAND, MINT, SKY, WHITE = 0xF6E7C8, 0xF5C7A1, 0xE08E6D, 0xF2D9A6, 0xBFE3C8, 0xCFE2F3, 0xFBF8F2
ROOF_RED, ROOF_TERRA, ROOF_SLATE, ROOF_GREEN, ROOF_BLUE = 0xD9574A, 0xE07B4F, 0x56637A, 0x6BAA75, 0x4F7CC2
GLASS, GLASS_DEEP, FRAME, DOOR, TRIM, STONE, WOOD = 0x9AD4F5, 0x6FAEDF, 0xFFFFFF, 0x8A5A3B, 0xFFF6E5, 0xD8D2C6, 0xB07A4A


class _outline_state:
    def __init__(self, b: MeshBuilder, on: bool) -> None:
        self.b, self.on = b, on

    def __enter__(self) -> MeshBuilder:
        self.saved = self.b.outline_next
        self.b.outline_next = self.on
        return self.b

    def __exit__(self, *exc) -> None:
        self.b.outline_next = self.saved


def outlined(b: MeshBuilder) -> _outline_state:
    """Only big masses (walls, roofs, columns, domes) get the outline hull. Small or
    overlapping parts would double the triangles and their hulls poke through
    neighbouring faces as black specks."""
    return _outline_state(b, True)


def details(b: MeshBuilder) -> _outline_state:
    return _outline_state(b, False)


def roof_poly(b: MeshBuilder, color: int, verts, faces) -> None:
    with outlined(b):
        b.poly(M(color), verts, faces)


def M(color: int) -> bpy.types.Material:
    return material(f"c_{color:06x}", hex_rgb(color))


# ----------------------------------------------------------------- primitives

def walls(b: MeshBuilder, w, d, h, color, z0=0.0, bevel=0.18) -> None:
    with outlined(b):
        b.box(M(color), (0, 0, z0 + h / 2), (w, d, h), bevel=bevel)


def gable_roof(b, w, d, h, rise, color, overhang=0.6, along_x=True) -> None:
    hw, hd = w / 2 + overhang, d / 2 + overhang
    if along_x:  # ridge along X
        v = [(-hw, -hd, h), (hw, -hd, h), (hw, hd, h), (-hw, hd, h), (-hw, 0, h + rise), (hw, 0, h + rise)]
        f = [(0, 1, 5, 4), (2, 3, 4, 5), (0, 4, 3), (1, 2, 5), (0, 3, 2, 1)]
    else:
        v = [(-hw, -hd, h), (hw, -hd, h), (hw, hd, h), (-hw, hd, h), (0, -hd, h + rise), (0, hd, h + rise)]
        f = [(1, 2, 5, 4), (3, 0, 4, 5), (0, 1, 4), (2, 3, 5), (0, 3, 2, 1)]
    roof_poly(b, color, v, f)
    # chunky fascia under the eaves
    b.box(M(TRIM), (0, 0, h - 0.12), (w + 0.25, d + 0.25, 0.25), bevel=0.05)


def hip_roof(b, w, d, h, rise, color, overhang=0.5) -> None:
    hw, hd = w / 2 + overhang, d / 2 + overhang
    ridge = max(0.0, (w - d) / 2)
    v = [(-hw, -hd, h), (hw, -hd, h), (hw, hd, h), (-hw, hd, h), (-ridge, 0, h + rise), (ridge, 0, h + rise)]
    f = [(0, 1, 5, 4), (2, 3, 4, 5), (0, 4, 3), (1, 2, 5), (0, 3, 2, 1)]
    roof_poly(b, color, v, f)
    b.box(M(TRIM), (0, 0, h - 0.12), (w + 0.25, d + 0.25, 0.25), bevel=0.05)


def flat_roof(b, w, d, h, color=STONE, parapet=0.6) -> None:
    b.box(M(color), (0, 0, h + 0.1), (w - 0.2, d - 0.2, 0.2))
    t = 0.35
    # Side walls stop short of the front/back walls: overlapping coplanar faces z-fight.
    for x, y, sx, sy in ((0, -d / 2 + t / 2, w, t), (0, d / 2 - t / 2, w, t),
                         (-w / 2 + t / 2, 0, t, d - 2 * t), (w / 2 - t / 2, 0, t, d - 2 * t)):
        b.box(M(TRIM), (x, y, h + parapet / 2), (sx, sy, parapet), bevel=0.06)


def window(b, side, along, z, ww, wh, w, d, glass=GLASS, frame=FRAME) -> None:
    """Framed window on a wall. side: front(-Y) back(+Y) left(-X) right(+X)."""
    with details(b):
        _window(b, side, along, z, ww, wh, w, d, glass, frame)


def _window(b, side, along, z, ww, wh, w, d, glass, frame) -> None:
    out = 0.06
    if side in ("front", "back"):
        y = (-d / 2 - out) if side == "front" else (d / 2 + out)
        b.box(M(frame), (along, y, z), (ww + 0.24, 0.14, wh + 0.24))
        b.box(M(glass), (along, y + (-0.05 if side == "front" else 0.05), z), (ww, 0.06, wh))
        b.box(M(frame), (along, y + (-0.08 if side == "front" else 0.08), z - wh / 2 - 0.12), (ww + 0.4, 0.22, 0.1))  # sill
    else:
        x = (-w / 2 - out) if side == "left" else (w / 2 + out)
        b.box(M(frame), (x, along, z), (0.14, ww + 0.24, wh + 0.24))
        b.box(M(glass), (x + (-0.05 if side == "left" else 0.05), along, z), (0.06, ww, wh))


def window_grid(b, w, d, floors, floor_h, z0=0.0, sides=("front", "back", "left", "right"),
                spacing=2.6, skip_ground_center=True, glass=GLASS, frame=FRAME, ww=None) -> None:
    for side in sides:
        span = w if side in ("front", "back") else d
        cols = max(1, int((span - 1.2) // spacing))
        step = (span - 1.2) / cols
        width = ww if ww is not None else min(1.5, step * 0.55)
        for floor in range(floors):
            z = z0 + floor * floor_h + floor_h * 0.55
            for c in range(cols):
                along = -span / 2 + 0.6 + step * (c + 0.5)
                if skip_ground_center and floor == 0 and side == "front" and abs(along) < 1.8:
                    continue
                window(b, side, along, z, width, floor_h * 0.48, w, d, glass, frame)


def door(b, d, width=1.5, height=2.4, color=DOOR, x=0.0, frame=TRIM) -> None:
    with details(b):
        y = -d / 2 - 0.08
        b.box(M(frame), (x, y, height / 2 + 0.06), (width + 0.4, 0.2, height + 0.25), bevel=0.05)
        b.box(M(color), (x, y - 0.07, height / 2), (width, 0.12, height))
        b.sphere(M(0xF2C14E), (x + width * 0.32, y - 0.16, height * 0.48), (0.08, 0.08, 0.08), segments=8, rings=6)


def awning(b, d, width, z, depth=1.6, colors=(0xE5534B, 0xFFFFFF), x=0.0, stripes=None) -> None:
    with details(b):
        n = stripes or max(3, int(width / 0.9))
        sw = width / n
        tilt = 0.45
        for i in range(n):
            cx = x - width / 2 + sw * (i + 0.5)
            b.box(M(colors[i % 2]), (cx, -d / 2 - depth / 2 * math.cos(tilt), z - depth / 2 * math.sin(tilt)),
                  (sw, depth, 0.12), rotation=(tilt, 0, 0))
        b.box(M(colors[0]), (x, -d / 2 - depth * math.cos(tilt) - 0.02, z - depth * math.sin(tilt) - 0.18), (width, 0.1, 0.4))


def sign(b, d, width, height, z, color, text_color=WHITE, x=0.0) -> None:
    with details(b):
        y = -d / 2 - 0.2
        b.box(M(color), (x, y, z), (width, 0.25, height), bevel=0.08)
        b.box(M(text_color), (x, y - 0.14, z), (width * 0.7, 0.04, height * 0.28))


def chimney(b, x, y, z, color=BRICK) -> None:
    b.box(M(color), (x, y, z + 1.2), (0.9, 0.9, 2.4), bevel=0.06)
    b.box(M(TRIM), (x, y, z + 2.45), (1.1, 1.1, 0.24), bevel=0.04)


def columns(b, xs, y, height, radius=0.32, color=WHITE, z0=0.0) -> None:
    for x in xs:
        with outlined(b):
            b.cone(M(color), (x, y, z0 + height / 2), radius, radius * 0.88, height, segments=10)
        b.box(M(color), (x, y, z0 + height + 0.12), (radius * 2.6, radius * 2.6, 0.24))
        b.box(M(color), (x, y, z0 + 0.1), (radius * 2.6, radius * 2.6, 0.2))


def steps(b, d, width, count=3, color=STONE) -> None:
    with details(b):
        for i in range(count):
            b.box(M(color), (0, -d / 2 - 0.5 - (count - 1 - i) * 0.45, 0.12 + i * 0.2), (width - i * 0.6, 1.0 + (count - 1 - i) * 0.9, 0.24))


# ------------------------------------------------------------------ archetypes

def house(b, w, d, h, wall=CREAM, roof=ROOF_RED, context=False):
    walls(b, w, d, h, wall)
    gable_roof(b, w, d, h, min(3.0, h * 0.85), roof)
    door(b, d, 1.5, min(2.5, h * 0.7))
    if not context:
        window_grid(b, w, d, 1, h, sides=("front", "left", "right"), spacing=3.0)
        chimney(b, w * 0.25, d * 0.15, h + 0.9)
        awning(b, d, 2.4, min(2.5, h * 0.7) + 0.6, depth=0.9, colors=(0x6BAA75, 0xFFFFFF), stripes=4)
    else:
        window_grid(b, w, d, 1, h, sides=("front",), spacing=3.2)


def townhouse(b, w, d, h):
    walls(b, w, d, h, BRICK)
    b.box(M(TRIM), (0, 0, h / 2), (w + 0.1, d + 0.1, 0.25))  # floor band
    gable_roof(b, w, d, h, 2.6, ROOF_SLATE, along_x=False)
    door(b, d, 1.4, 2.4, color=0x3E6D9C)
    window_grid(b, w, d, 2, h / 2, sides=("front", "back", "left", "right"), spacing=2.6)
    chimney(b, -w * 0.25, d * 0.3, h + 1.2)


def apartment(b, w, d, h, wall=PEACH, context=False):
    walls(b, w, d, h, wall)
    floors = max(3, int(h // 3))
    fh = h / floors
    window_grid(b, w, d, floors, fh, spacing=2.4)
    for f in range(1, floors):
        b.box(M(TRIM), (0, 0, f * fh), (w + 0.12, d + 0.12, 0.18))
    flat_roof(b, w, d, h)
    door(b, d, 1.8, 2.5, color=0x3E6D9C)
    if not context:
        b.cone(M(0x8A9BB0), (w * 0.25, d * 0.15, h + 1.4), 0.9, 0.9, 1.6, segments=10)  # water tank
        b.cone(M(0x6B7A8F), (w * 0.25, d * 0.15, h + 2.4), 1.0, 0.0, 0.6, segments=10)
        for x in (-w / 4, w / 4):  # balconies
            for f in range(1, floors):
                b.box(M(WHITE), (x, -d / 2 - 0.6, f * fh + 0.1), (2.4, 1.2, 0.15))
                b.box(M(WHITE), (x, -d / 2 - 1.15, f * fh + 0.55), (2.4, 0.1, 0.8))


def shop(b, w, d, h, wall=SAND, awning_colors=(0xE5534B, 0xFFFFFF), sign_color=0xE5534B):
    walls(b, w, d, h, wall)
    flat_roof(b, w, d, h, parapet=0.8)
    b.box(M(FRAME), (0, -d / 2 - 0.06, 1.55), (w * 0.7, 0.14, 2.3), bevel=0.04)  # display window
    b.box(M(GLASS), (0, -d / 2 - 0.12, 1.55), (w * 0.7 - 0.3, 0.06, 2.0))
    door(b, d, 1.4, 2.4, x=w * 0.39, color=0x3E6D9C)
    awning(b, d, w * 0.92, 3.3, colors=awning_colors)
    sign(b, d, w * 0.6, 0.9, h + 0.1, sign_color)
    window_grid(b, w, d, 1, h, sides=("left", "right", "back"), spacing=3.2)


def restaurant(b, w, d, h):
    shop(b, w, d, h, wall=0xF4C6B0, awning_colors=(0x2F8F6B, 0xFFF6E5), sign_color=0x2F8F6B)
    chimney(b, -w * 0.3, d * 0.2, h + 0.6, color=0x9C5B3F)
    for x in (-w * 0.25, w * 0.05):  # outdoor tables
        b.cone(M(WOOD), (x, -d / 2 - 2.6, 0.5), 0.6, 0.6, 0.12, segments=10)
        b.cone(M(WOOD), (x, -d / 2 - 2.6, 0.25), 0.08, 0.08, 0.5, segments=6)


def market(b, w, d, h):
    walls(b, w * 0.95, d * 0.9, h * 0.45, CREAM)
    columns(b, [-w / 2 + 0.6, w / 2 - 0.6], -d / 2 + 0.6, h * 0.55, radius=0.3, color=WOOD)
    columns(b, [-w / 2 + 0.6, w / 2 - 0.6], d / 2 - 0.6, h * 0.55, radius=0.3, color=WOOD)
    gable_roof(b, w, d, h * 0.55, 3.0, 0xF2B544, overhang=0.9)
    for i, color in enumerate((0xE5534B, 0x4F7CC2, 0x6BAA75, 0xF2B544)):
        x = -w / 2 + w * (i + 0.5) / 4
        b.box(M(WOOD), (x, -d / 2 - 1.1, 0.5), (2.6, 1.2, 1.0), bevel=0.05)  # stall
        b.box(M(color), (x, -d / 2 - 1.1, 1.15), (2.4, 1.0, 0.3), bevel=0.08)  # produce
    door(b, d * 0.9, 2.2, 2.4)
    sign(b, d, w * 0.5, 1.0, h * 0.55 + 0.7, 0xE5534B)


def office(b, w, d, h, wall=SKY):
    walls(b, w, d, h, wall, bevel=0.12)
    floors = max(4, int(h // 3))
    fh = h / floors
    for f in range(floors):  # continuous glass bands
        z = f * fh + fh * 0.55
        for side_y in (-d / 2 - 0.05, d / 2 + 0.05):
            b.box(M(GLASS_DEEP), (0, side_y, z), (w - 1.0, 0.1, fh * 0.55))
        for side_x in (-w / 2 - 0.05, w / 2 + 0.05):
            b.box(M(GLASS_DEEP), (side_x, 0, z), (0.1, d - 1.0, fh * 0.55))
    flat_roof(b, w, d, h)
    b.box(M(0x8A9BB0), (w * 0.2, 0, h + 0.9), (3.0, 2.4, 1.6), bevel=0.1)  # rooftop unit
    b.box(M(FRAME), (0, -d / 2 - 0.6, 3.0), (5.0, 1.4, 0.25))  # entrance canopy
    door(b, d, 2.4, 2.6, color=GLASS_DEEP, frame=FRAME)


def hq(b, w, d, h):
    podium = 6.0
    walls(b, w, d, podium, WHITE, bevel=0.2)
    window_grid(b, w, d, 2, podium / 2, spacing=2.8, glass=GLASS_DEEP)
    tw, td = w * 0.62, d * 0.68
    walls(b, tw, td, h - podium, 0x3E6FB0, z0=podium, bevel=0.25)
    floors = int((h - podium) // 3)
    for f in range(floors):
        z = podium + f * 3 + 1.6
        b.box(M(GLASS), (0, -td / 2 - 0.06, z), (tw - 0.8, 0.12, 1.7))
        b.box(M(GLASS), (0, td / 2 + 0.06, z), (tw - 0.8, 0.12, 1.7))
        b.box(M(GLASS), (-tw / 2 - 0.06, 0, z), (0.12, td - 0.8, 1.7))
        b.box(M(GLASS), (tw / 2 + 0.06, 0, z), (0.12, td - 0.8, 1.7))
    b.box(M(WHITE), (0, 0, h + 0.3), (tw + 0.6, td + 0.6, 0.6), bevel=0.1)  # crown
    b.cone(M(0xF2C14E), (0, 0, h + 2.4), 0.5, 0.05, 3.6, segments=8)  # spire
    b.box(M(WHITE), (0, -d / 2 - 1.3, 3.4), (8.0, 2.8, 0.3), bevel=0.08)  # canopy
    columns(b, (-3.6, 3.6), -d / 2 - 2.4, 3.3, radius=0.22, color=WHITE)
    door(b, d, 3.0, 2.8, color=GLASS_DEEP, frame=WHITE)
    sign(b, d, 7.0, 1.3, podium - 0.9, 0xF2C14E, text_color=0x3E6FB0)


def bank(b, w, d, h):
    walls(b, w, d, h, 0xEDE3CF)
    window_grid(b, w, d, 2, h / 2, sides=("left", "right", "back"), spacing=3.0)
    columns(b, [-w / 2 + 1.5 + i * (w - 3) / 3 for i in range(4)], -d / 2 - 1.3, h - 0.6, radius=0.42)
    b.box(M(WHITE), (0, -d / 2 - 1.0, h - 0.2), (w + 0.4, 2.6, 0.6), bevel=0.06)  # entablature
    roof_poly(b, 0xF3EEE2, [(-w / 2 - 0.2, -d / 2 - 2.3, h + 0.1), (w / 2 + 0.2, -d / 2 - 2.3, h + 0.1), (0, -d / 2 - 2.3, h + 2.4),
                         (-w / 2 - 0.2, -d / 2 + 0.2, h + 0.1), (w / 2 + 0.2, -d / 2 + 0.2, h + 0.1), (0, -d / 2 + 0.2, h + 2.4)],
           [(0, 1, 2), (3, 5, 4), (0, 3, 4, 1), (1, 4, 5, 2), (2, 5, 3, 0)])  # pediment
    flat_roof(b, w, d, h, parapet=0.5)
    steps(b, d - 2.6, w * 0.8, 3)
    door(b, d, 2.0, 3.2, color=0x5A4632)
    b.cone(M(0xF2C14E), (0, -d / 2 - 2.45, h + 1.0), 0.45, 0.45, 0.1, segments=12, rotation=(math.pi / 2, 0, 0))  # coin


def civic(b, w, d, h):
    walls(b, w, d, h, 0xF1ECE2)
    window_grid(b, w, d, 2, h / 2, spacing=3.0, skip_ground_center=True)
    columns(b, [-4.5, -1.5, 1.5, 4.5], -d / 2 - 1.2, h * 0.6, radius=0.38)
    b.box(M(WHITE), (0, -d / 2 - 1.0, h * 0.6 + 0.3), (11, 2.4, 0.5))
    flat_roof(b, w, d, h)
    b.cone(M(0xD8E2EC), (0, 0, h + 1.2), 3.4, 3.4, 2.4, segments=16)  # drum
    with outlined(b):
        b.sphere(M(0x7FB3D5), (0, 0, h + 2.4), (3.6, 3.6, 3.0), segments=18, rings=10, keep=lambda x, y, z: z > -0.05)  # dome
    b.cone(M(0x8A9BB0), (0, 0, h + 6.2), 0.08, 0.08, 2.0, segments=6)  # flag pole
    b.box(M(0x4F7CC2), (0.6, 0, h + 6.8), (1.1, 0.06, 0.7))
    steps(b, d, 9, 3)
    door(b, d, 2.2, 3.0, color=0x5A4632)


def school(b, w, d, h):
    walls(b, w, d, h, 0xF7D774)
    window_grid(b, w, d, 2, h / 2, spacing=2.8)
    hip_roof(b, w, d, h, 2.4, ROOF_RED)
    b.box(M(0xF7D774), (0, -d / 2 + 1.0, h + 2.0), (3.2, 2.4, 4.0), bevel=0.15)  # clock tower
    roof_poly(b, ROOF_RED, [(-2.0, -d / 2 - 0.4, h + 4.0), (2.0, -d / 2 - 0.4, h + 4.0), (2.0, -d / 2 + 2.4, h + 4.0), (-2.0, -d / 2 + 2.4, h + 4.0), (0, -d / 2 + 1.0, h + 6.0)],
           [(0, 1, 4), (1, 2, 4), (2, 3, 4), (3, 0, 4), (0, 3, 2, 1)])
    b.cone(M(WHITE), (0, -d / 2 - 0.25, h + 2.6), 1.0, 1.0, 0.15, segments=16, rotation=(math.pi / 2, 0, 0))
    b.box(M(0x2B2233), (0, -d / 2 - 0.36, h + 2.85), (0.1, 0.06, 0.7))
    b.box(M(0x2B2233), (0.22, -d / 2 - 0.36, h + 2.6), (0.5, 0.06, 0.1))
    door(b, d, 2.4, 2.6, color=0x3E6D9C)


def hospital(b, w, d, h):
    walls(b, w, d, h, WHITE)
    floors = max(3, int(h // 3.2))
    window_grid(b, w, d, floors, h / floors, spacing=2.6)
    flat_roof(b, w, d, h)
    b.box(M(0xE5534B), (0, -d / 2 - 0.2, h - 1.6), (2.6, 0.3, 0.8))  # red cross
    for dz in (-1.15, 1.15):  # vertical arms only above/below the bar (no coplanar overlap)
        b.box(M(0xE5534B), (0, -d / 2 - 0.2, h - 1.6 + dz), (0.8, 0.3, 0.9))
    b.box(M(0x6FAEDF), (0, -d / 2 - 1.6, 3.2), (7.0, 3.0, 0.35), bevel=0.08)  # canopy
    columns(b, (-3.0, 3.0), -d / 2 - 2.8, 3.0, radius=0.2)
    b.cone(M(0xE5534B), (w * 0.25, 0, h + 0.15), 3.0, 3.0, 0.1, segments=20)  # helipad
    b.cone(M(WHITE), (w * 0.25, 0, h + 0.22), 2.4, 2.4, 0.05, segments=20)
    door(b, d, 2.8, 2.6, color=GLASS_DEEP, frame=WHITE)


def pavilion(b, w, d, h):
    b.box(M(STONE), (0, 0, 0.25), (w, d, 0.5), bevel=0.1)
    columns(b, [-w / 2 + 0.8, w / 2 - 0.8], -d / 2 + 0.8, h - 0.5, radius=0.25, color=WOOD, z0=0.5)
    columns(b, [-w / 2 + 0.8, w / 2 - 0.8], d / 2 - 0.8, h - 0.5, radius=0.25, color=WOOD, z0=0.5)
    roof_poly(b, ROOF_GREEN, [(-w / 2 - 0.6, -d / 2 - 0.6, h), (w / 2 + 0.6, -d / 2 - 0.6, h), (w / 2 + 0.6, d / 2 + 0.6, h), (-w / 2 - 0.6, d / 2 + 0.6, h), (0, 0, h + 3.0)],
           [(0, 1, 4), (1, 2, 4), (2, 3, 4), (3, 0, 4), (0, 3, 2, 1)])
    b.sphere(M(0xF2C14E), (0, 0, h + 3.1), (0.3, 0.3, 0.3), segments=10, rings=6)
    for x in (-1.6, 1.6):  # benches inside
        b.box(M(WOOD), (x, 0, 0.9), (2.0, 0.6, 0.15))


def station(b, w, d, h):
    walls(b, w, d * 0.6, h * 0.7, 0xD9CBB6)
    window_grid(b, w, d * 0.6, 1, h * 0.7, sides=("front",), spacing=3.0)
    b.box(M(0x4F7CC2), (0, -d * 0.05, h), (w + 2.0, d + 1.0, 0.4), bevel=0.1)  # big canopy
    columns(b, [-w / 2 + 0.6 + i * (w - 1.2) / 4 for i in range(5)], -d / 2 - 0.2, h - 0.2, radius=0.2, color=0x8A9BB0)
    b.cone(M(WHITE), (0, -d / 2 - 0.6, h + 1.2), 0.9, 0.9, 0.2, segments=16, rotation=(math.pi / 2, 0, 0))  # clock
    b.box(M(0x8A9BB0), (0, -d / 2 - 0.6, h + 0.5), (0.2, 0.2, 1.0))
    door(b, d * 0.6, 2.4, 2.6, color=GLASS_DEEP, frame=WHITE)
    sign(b, d * 0.6, 5.0, 0.8, h * 0.7 - 0.6, 0x4F7CC2)


def warehouse(b, w, d, h, wall=0xB9C9D6):
    walls(b, w, d, h, wall, bevel=0.1)
    for i in range(int(w // 1.2)):  # corrugated ribs
        x = -w / 2 + 0.6 + i * 1.2
        b.box(M(0x9FB2C2), (x, -d / 2 - 0.05, h / 2), (0.18, 0.1, h - 0.4))
    gable_roof(b, w, d, h, 2.0, ROOF_SLATE, overhang=0.4, along_x=False)
    b.box(M(0xE8E2D4), (0, -d / 2 - 0.08, 2.4), (6.0, 0.15, 4.8))  # roller door
    for z in range(1, 8):
        b.box(M(0xCFC6B4), (0, -d / 2 - 0.17, z * 0.6), (5.8, 0.04, 0.08))
    door(b, d, 1.2, 2.3, x=w * 0.3, color=0xF2B544)


def garage(b, w, d, h):
    walls(b, w, d, h, 0xE3DED5)
    flat_roof(b, w, d, h, parapet=0.5)
    for x in (-w / 4, w / 4):
        b.box(M(0xF2B544), (x, -d / 2 - 0.08, 1.8), (3.6, 0.15, 3.6))
        for z in range(1, 6):
            b.box(M(0xD99A2B), (x, -d / 2 - 0.17, z * 0.6), (3.4, 0.04, 0.08))
    sign(b, d, 4.0, 0.8, h - 0.4, 0x4F7CC2)
    window_grid(b, w, d, 1, h, sides=("left", "right"), spacing=3.0)


def barn(b, w, d, h, context=False):
    walls(b, w, d, h, 0xC8483C)
    # gambrel roof: steep lower slopes, shallow upper slopes (ridge along X)
    hw, hd, o = w / 2 + 0.5, d / 2 + 0.5, 0.0
    v = [(-hw, -hd, h), (hw, -hd, h), (hw, -hd * 0.55, h + 2.0), (-hw, -hd * 0.55, h + 2.0),
         (-hw, 0, h + 3.2 + o), (hw, 0, h + 3.2 + o),
         (-hw, hd * 0.55, h + 2.0), (hw, hd * 0.55, h + 2.0), (-hw, hd, h), (hw, hd, h)]
    f = [(0, 1, 2, 3), (3, 2, 5, 4), (4, 5, 7, 6), (6, 7, 9, 8), (0, 3, 4, 6, 8), (1, 9, 7, 5, 2), (0, 8, 9, 1)]
    roof_poly(b, 0x7A4A3A, v, f)
    b.box(M(WHITE), (0, -d / 2 - 0.08, 1.7), (3.4, 0.14, 3.4))  # door frame
    b.box(M(0xA73A30), (0, -d / 2 - 0.14, 1.6), (3.0, 0.08, 3.1))
    if not context:
        for sgn in (1, -1):  # white X brace
            b.box(M(WHITE), (0, -d / 2 - 0.2 - (0.03 if sgn > 0 else 0.0), 1.6), (0.18, 0.06, 4.2), rotation=(0, sgn * 0.78, 0))
        b.box(M(WHITE), (0, -d / 2 - 0.1, h + 1.2), (1.2, 0.12, 1.2))  # hay loft
        b.box(M(0x7A4A3A), (0, -d / 2 - 0.16, h + 1.2), (0.9, 0.06, 0.9))


def build_archetype(name: str) -> MeshBuilder:
    w, d, h = FOOTPRINTS[name]
    b = MeshBuilder()
    b.smooth = False
    b.outline_next = False  # opt-in via outlined()
    {
        "HOUSE": lambda: house(b, w, d, h),
        "TOWNHOUSE": lambda: townhouse(b, w, d, h),
        "APARTMENT": lambda: apartment(b, w, d, h),
        "SHOP": lambda: shop(b, w, d, h),
        "RESTAURANT": lambda: restaurant(b, w, d, h),
        "MARKET": lambda: market(b, w, d, h),
        "OFFICE": lambda: office(b, w, d, h),
        "HQ": lambda: hq(b, w, d, h),
        "BANK": lambda: bank(b, w, d, h),
        "CIVIC": lambda: civic(b, w, d, h),
        "SCHOOL": lambda: school(b, w, d, h),
        "HOSPITAL": lambda: hospital(b, w, d, h),
        "PARK_PAVILION": lambda: pavilion(b, w, d, h),
        "STATION": lambda: station(b, w, d, h),
        "WAREHOUSE": lambda: warehouse(b, w, d, h),
        "GARAGE": lambda: garage(b, w, d, h),
        "BARN": lambda: barn(b, w, d, h),
        "CONTEXT_HOUSE": lambda: house(b, w, d, h, wall=0xE9DCC4, roof=0xB86B5E, context=True),
        "CONTEXT_BLOCK": lambda: apartment(b, w, d, h, wall=0xDCD6CC, context=True),
        "CONTEXT_BARN": lambda: barn(b, w, d, h, context=True),
    }[name]()
    return b


def main() -> None:
    out = arg("out", "apps/web/public/models/buildings.glb")
    preview = arg("preview")
    reset_scene()
    objects = []
    for name in FOOTPRINTS:
        objects.append(build_archetype(name).build_vertex_colored(f"bld_{name}", OUTLINE, OUTLINE_W))
    tris = {o.name: sum(len(p.vertices) - 2 for p in o.data.polygons) for o in objects}
    if preview:
        os.makedirs(preview, exist_ok=True)
        for obj in objects:
            others = [o for o in objects if o is not obj]
            for o in others:
                o.hide_render = True
            obj.hide_render = False
            w, d, h = FOOTPRINTS[obj.name[4:]]
            render_preview(os.path.join(preview, f"{obj.name}.png"), target=(0, 0, h * 0.55),
                           distance=max(w, d, h) * 2.1, angles=(0.55,), height=h * 0.9 + 4)
        for o in objects:
            o.hide_render = False
    # Flat-shaded: the web computes face normals itself (toNonIndexed + computeVertexNormals).
    export_glb(out, vertex_colors=True, normals=False)
    print(f"exported {out} ({os.path.getsize(out) / 1024:.0f} KiB)")
    for name, count in tris.items():
        print(f"  {name}: {count} tris")


if __name__ == "__main__":
    main()
