/**
 * Loads the Blender-authored character model (tools/blender/characters.py →
 * public/models/character.glb) once per page and hands it to the factory.
 *
 * Loading is best-effort: until it resolves, or if it fails, characters are
 * built procedurally, so a missing or broken asset never blanks the world.
 */
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { hasCharacterTemplate, setCharacterTemplate } from "./characterFactory.js";

export const CHARACTER_MODEL_URL = `${import.meta.env.BASE_URL}models/character.glb`;

let pending: Promise<boolean> | null = null;

/** Resolves true once the template is installed, false if loading failed. */
export function loadCharacterTemplate(url: string = CHARACTER_MODEL_URL): Promise<boolean> {
  if (hasCharacterTemplate()) return Promise.resolve(true);
  pending ??= new GLTFLoader()
    .loadAsync(url)
    .then((gltf) => {
      setCharacterTemplate(gltf.scene);
      return true;
    })
    .catch((error: unknown) => {
      console.warn("Character model unavailable; using procedural figures.", error);
      pending = null; // allow a later retry
      return false;
    });
  return pending;
}
