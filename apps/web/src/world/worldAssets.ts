/**
 * Loads the Blender-authored city models once per page (public/models/buildings.glb
 * and decor.glb) and installs them in the registry. Best-effort: until it resolves,
 * or if it fails, the procedural buildings and decor stay.
 */
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { hasWorldModels, setWorldModels } from "./worldModels.js";

const BASE = `${import.meta.env.BASE_URL}models/`;

let pending: Promise<boolean> | null = null;

/** Resolves true once the models are installed, false if loading failed. */
export function loadWorldModels(): Promise<boolean> {
  if (hasWorldModels()) return Promise.resolve(true);
  const loader = new GLTFLoader();
  pending ??= Promise.all([loader.loadAsync(`${BASE}buildings.glb`), loader.loadAsync(`${BASE}decor.glb`)])
    .then(([buildings, decor]) => {
      setWorldModels(buildings.scene, decor.scene);
      return true;
    })
    .catch((error: unknown) => {
      console.warn("City models unavailable; using procedural buildings.", error);
      pending = null;
      return false;
    });
  return pending;
}
