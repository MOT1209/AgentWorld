"""Shared helpers for the AgentWorld asset scripts (run with Blender's `bpy`).

Conventions every asset follows so the web app can consume it:
  * Blender is Z-up; the glTF exporter converts to the web's Y-up.
  * 1 Blender unit = 1 world unit. Characters face -Y in Blender (= +Z in three.js).
  * Materials are named by ROLE (`skin`, `hair`, `top`, ...), not by colour. The web
    app re-colours them per agent, so the colours set here are previews only.
  * A mesh named `<name>__outline` is an inverted hull: render it back-face only.
"""
from __future__ import annotations

import math
import os
import sys
from typing import Iterable, Sequence

import bmesh
import bpy
from mathutils import Matrix, Vector


def reset_scene() -> None:
    bpy.ops.wm.read_factory_settings(use_empty=True)
    for block in (bpy.data.meshes, bpy.data.materials, bpy.data.objects):
        for item in list(block):
            block.remove(item)


def material(name: str, rgb: Sequence[float], roughness: float = 0.8) -> bpy.types.Material:
    mat = bpy.data.materials.get(name)
    if mat is None:
        mat = bpy.data.materials.new(name)
        mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    if bsdf is not None:
        bsdf.inputs["Base Color"].default_value = (*rgb, 1.0)
        bsdf.inputs["Roughness"].default_value = roughness
    mat.diffuse_color = (*rgb, 1.0)
    return mat


def hex_rgb(value: int) -> tuple[float, float, float]:
    """sRGB hex → linear RGB (what Blender stores)."""
    def lin(c: float) -> float:
        return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4
    return tuple(lin(((value >> s) & 0xFF) / 255.0) for s in (16, 8, 0))  # type: ignore[return-value]


def empty(name: str, location: Sequence[float], parent: bpy.types.Object | None = None) -> bpy.types.Object:
    obj = bpy.data.objects.new(name, None)
    obj.empty_display_size = 0.05
    bpy.context.scene.collection.objects.link(obj)
    if parent is not None:
        obj.parent = parent
    obj.location = location
    return obj


class MeshBuilder:
    """Accumulates primitives into one bmesh with per-face material slots."""

    def __init__(self) -> None:
        self.bm = bmesh.new()
        self.materials: list[bpy.types.Material] = []

    def _slot(self, mat: bpy.types.Material) -> int:
        if mat not in self.materials:
            self.materials.append(mat)
        return self.materials.index(mat)

    def _add(self, temp: bmesh.types.BMesh, mat: bpy.types.Material, matrix: Matrix) -> None:
        bmesh.ops.transform(temp, matrix=matrix, verts=temp.verts)
        slot = self._slot(mat)
        for face in temp.faces:
            face.material_index = slot
            face.smooth = True
        mesh = bpy.data.meshes.new("_tmp")
        temp.to_mesh(mesh)
        temp.free()
        self.bm.from_mesh(mesh)
        bpy.data.meshes.remove(mesh)

    def sphere(self, mat, center, radii, segments=16, rings=10, rotation=(0.0, 0.0, 0.0), keep=None) -> None:
        """UV sphere; `keep(x, y, z)` on the unit sphere drops every vertex it rejects."""
        temp = bmesh.new()
        bmesh.ops.create_uvsphere(temp, u_segments=segments, v_segments=rings, radius=1.0)
        if keep is not None:
            doomed = [v for v in temp.verts if not keep(v.co.x, v.co.y, v.co.z)]
            bmesh.ops.delete(temp, geom=doomed, context="VERTS")
        self._add(temp, mat, _trs(center, rotation, radii))

    def capsule(self, mat, center, radius, height, segments=12, scale=(1.0, 1.0)) -> None:
        """Vertical capsule (Z axis) of total `height`."""
        temp = bmesh.new()
        bmesh.ops.create_uvsphere(temp, u_segments=segments, v_segments=8, radius=radius)
        half = max(0.0, height / 2 - radius)
        for v in temp.verts:
            v.co.z += half if v.co.z > 0 else -half
            v.co.x *= scale[0]
            v.co.y *= scale[1]
        self._add(temp, mat, Matrix.Translation(Vector(center)))

    def cone(self, mat, center, r1, r2, depth, segments=12, rotation=(0.0, 0.0, 0.0), scale=(1.0, 1.0, 1.0)) -> None:
        temp = bmesh.new()
        bmesh.ops.create_cone(temp, cap_ends=True, segments=segments, radius1=r1, radius2=r2, depth=depth)
        self._add(temp, mat, _trs(center, rotation, scale))

    def box(self, mat, center, size, bevel=0.0, rotation=(0.0, 0.0, 0.0)) -> None:
        temp = bmesh.new()
        bmesh.ops.create_cube(temp, size=1.0)
        bmesh.ops.scale(temp, vec=Vector(size), verts=temp.verts)
        if bevel > 0:
            bmesh.ops.bevel(temp, geom=temp.edges[:], offset=bevel, segments=2, affect="EDGES", profile=0.5)
        self._add(temp, mat, _trs(center, rotation, (1.0, 1.0, 1.0)))

    def torus(self, mat, center, major, minor, arc=math.tau, segments=16, ring=6, rotation=(0.0, 0.0, 0.0)) -> None:
        temp = bmesh.new()
        verts_grid = []
        steps = segments if arc >= math.tau - 1e-6 else segments + 1
        for i in range(steps):
            a = arc * i / segments
            row = []
            for j in range(ring):
                b = math.tau * j / ring
                r = major + minor * math.cos(b)
                row.append(temp.verts.new((r * math.cos(a), r * math.sin(a), minor * math.sin(b))))
            verts_grid.append(row)
        for i in range(segments if arc >= math.tau - 1e-6 else segments):
            a_row = verts_grid[i]
            b_row = verts_grid[(i + 1) % len(verts_grid)]
            for j in range(ring):
                temp.faces.new((a_row[j], a_row[(j + 1) % ring], b_row[(j + 1) % ring], b_row[j]))
        self._add(temp, mat, _trs(center, rotation, (1.0, 1.0, 1.0)))

    def build(self, name: str, parent: bpy.types.Object | None, outline: bpy.types.Material | None = None,
              outline_width: float = 0.012, outline_skip: Iterable[bpy.types.Material] = ()) -> bpy.types.Object:
        mesh = bpy.data.meshes.new(name)
        self.bm.normal_update()
        self.bm.to_mesh(mesh)
        self.bm.free()
        for mat in self.materials:
            mesh.materials.append(mat)
        obj = bpy.data.objects.new(name, mesh)
        bpy.context.scene.collection.objects.link(obj)
        if parent is not None:
            obj.parent = parent
        if outline is not None:
            _outline_hull(obj, outline, outline_width, set(outline_skip))
        return obj


def _trs(center, rotation, scale) -> Matrix:
    return (
        Matrix.Translation(Vector(center))
        @ Matrix.Rotation(rotation[2], 4, "Z")
        @ Matrix.Rotation(rotation[1], 4, "Y")
        @ Matrix.Rotation(rotation[0], 4, "X")
        @ Matrix.Diagonal((*scale, 1.0))
    )


def _outline_hull(source: bpy.types.Object, outline_mat, width: float, skip: set) -> None:
    """Inverted hull: a copy pushed out along vertex normals, rendered back-face only."""
    bm = bmesh.new()
    bm.from_mesh(source.data)
    skip_slots = {i for i, m in enumerate(source.data.materials) if m in skip}
    doomed = [f for f in bm.faces if f.material_index in skip_slots]
    bmesh.ops.delete(bm, geom=doomed, context="FACES")
    bm.normal_update()
    for v in bm.verts:
        v.co += v.normal * width
    for f in bm.faces:
        f.material_index = 0
        f.smooth = True
    mesh = bpy.data.meshes.new(f"{source.name}__outline")
    bm.to_mesh(mesh)
    bm.free()
    mesh.materials.append(outline_mat)
    obj = bpy.data.objects.new(f"{source.name}__outline", mesh)
    bpy.context.scene.collection.objects.link(obj)
    obj.parent = source.parent
    obj.matrix_parent_inverse = source.matrix_parent_inverse.copy()
    obj.location = source.location


def export_glb(path: str) -> None:
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    bpy.ops.export_scene.gltf(
        filepath=path,
        export_format="GLB",
        export_yup=True,
        export_apply=True,
        export_normals=True,
        export_texcoords=False,
        export_materials="EXPORT",
        export_animations=False,
        export_cameras=False,
        export_lights=False,
        export_extras=True,
    )


def render_preview(path: str, target: Sequence[float] = (0, 0, 0.9), distance: float = 4.2,
                   angles: Sequence[float] = (0.0, 0.6), height: float = 1.2) -> list[str]:
    """Quick Cycles CPU renders from a few yaw angles. Returns written files."""
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    scene.cycles.samples = 24
    scene.cycles.device = "CPU"
    scene.render.resolution_x = 520
    scene.render.resolution_y = 640
    scene.render.film_transparent = False
    world = bpy.data.worlds.new("preview") if scene.world is None else scene.world
    scene.world = world
    world.use_nodes = True
    world.node_tree.nodes["Background"].inputs["Color"].default_value = (0.82, 0.88, 0.95, 1.0)
    world.node_tree.nodes["Background"].inputs["Strength"].default_value = 0.9
    sun = bpy.data.lights.new("sun", "SUN")
    sun.energy = 3.0
    sun_obj = bpy.data.objects.new("sun", sun)
    sun_obj.rotation_euler = (math.radians(50), math.radians(10), math.radians(30))
    scene.collection.objects.link(sun_obj)
    cam_data = bpy.data.cameras.new("cam")
    cam_data.lens = 50
    cam = bpy.data.objects.new("cam", cam_data)
    scene.collection.objects.link(cam)
    scene.camera = cam
    out = []
    base, ext = os.path.splitext(path)
    for i, yaw in enumerate(angles):
        pos = Vector((math.sin(yaw) * distance, -math.cos(yaw) * distance, height))
        cam.location = pos
        direction = Vector(target) - pos
        cam.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()
        scene.render.filepath = f"{base}_{i}{ext}"
        bpy.ops.render.render(write_still=True)
        out.append(scene.render.filepath)
    bpy.data.objects.remove(cam)
    bpy.data.objects.remove(sun_obj)
    return out


def arg(name: str, default: str | None = None) -> str | None:
    """`--name value` from the command line (works with `python script.py` and `blender -P`)."""
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else sys.argv[1:]
    if f"--{name}" in argv:
        i = argv.index(f"--{name}")
        return argv[i + 1] if i + 1 < len(argv) else default
    return default
