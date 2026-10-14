// -----------------------------------------------------------------------------
// Scene triggers and scene actions (SDK v0.14+, Gladys 5.1+).
//
// Triggers (manifest `scene_triggers`) are fired by the hub:
//   - event_detected  a camera saw something (motion, line crossing,
//                     intrusion…), or an alarm input went active;
//   - camera_offline  a camera stopped answering (or its recorder did);
//   - camera_online   it came back.
//
// Actions (manifest `scene_actions`) are handled here, keyed by their manifest
// `key`; index.js registers each with `gladys.onSceneAction(key, ...)`:
//   - take_snapshot   capture a fresh image and push it to Gladys, so the
//                     core's "send camera image" action sends THIS moment;
//   - set_detection   switch a detection on or off (arm / disarm a camera);
//   - goto_preset     send a PTZ camera to one of its presets.
//
// Rules: `fields` arrive resolved; a camera that cannot do what is asked is an
// output (`false`), not a failure; never fire a trigger from an action (a
// scene bound to it would loop through the integration). Keys are forever.
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';
import { TRIGGERS } from '../hub.js';
import { DETECTION_KINDS } from '../hikvision/isapi.js';

const logger = createLogger({ name: 'scenes' });

/** Every trigger key the hub fires (checked against the manifest by the tests). */
export const SCENE_TRIGGERS = Object.values(TRIGGERS);

/**
 * @param {() => import('../hub.js').Hub} getHub the current hub
 */
export function createSceneActions(getHub) {
  return {
    async take_snapshot({ device }) {
      try {
        await getHub().snapshotNow(device);
        return { captured: true };
      } catch (error) {
        logger.warn(`Scene action take_snapshot on ${device}: ${error.message}`);
        return { captured: false };
      }
    },

    async set_detection({ device, detection = 'motion', enabled = true }) {
      const kind = DETECTION_KINDS.includes(detection) ? detection : 'motion';
      try {
        const written = await getHub().setDetection(device, kind, enabled !== false);
        return { applied: true, enabled: written };
      } catch (error) {
        logger.warn(`Scene action set_detection (${kind}) on ${device}: ${error.message}`);
        return { applied: false };
      }
    },

    async goto_preset({ device, preset }) {
      try {
        await getHub().gotoPreset(device, Number(preset));
        return { moved: true };
      } catch (error) {
        logger.warn(`Scene action goto_preset ${preset} on ${device}: ${error.message}`);
        return { moved: false };
      }
    },
  };
}
