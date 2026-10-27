import { Schema, type InferSchemaType, type Types } from 'mongoose';

/**
 * One-shot alarm state.
 *
 * One document per alarm set via `/alarm set`. At `fire_at` a scheduled
 * job removes the document and posts `message` in `channel_id`, so an
 * alarm fires at most once. `mention_everyone` records whether the
 * creator could mention `@everyone` and roles in that channel when the
 * alarm was set; without it only user mentions ping.
 */
export const alarmSchema = new Schema({
  alarm_id: { type: String, required: true, unique: true },
  channel_id: { type: String, required: true },
  creator_id: { type: String, required: true, index: true },
  message: { type: String, required: true },
  fire_at: { type: Number, required: true },
  mention_everyone: { type: Boolean, required: true },
});

export type AlarmDoc = InferSchemaType<typeof alarmSchema> & {
  readonly _id: Types.ObjectId;
};
