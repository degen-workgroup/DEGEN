import { GuildChannel, GuildMember, VoiceState } from 'discord.js';
import {
	Collection,
	Db,
	DeleteWriteOpResultObject,
	InsertOneWriteOpResult,
	MongoError,
} from 'mongodb';
import constants from '../../service/constants/constants';
import { POAPParticipant } from '../../types/poap/POAPParticipant';
import Log, { LogUtils } from '../../utils/Log';
import dayjs, { Dayjs } from 'dayjs';
import MongoDbUtils from '../../utils/MongoDbUtils';
import { POAPSettings } from '../../types/poap/POAPSettings';

const HandleParticipantDuringEvent = async (oldState: VoiceState, newState: VoiceState): Promise<any> => {
	if (hasUserBeenDeafened(oldState, newState)) {
		if (!await isStateChangeRelatedToActiveEvent(oldState, newState)) {
			return;
		}
		// user has deafened and state change is related to active event
		await removeDeafenedUser(oldState, newState);
		return;
	}
	
	if (hasUserEnteredChannel(oldState, newState)) {
		if (!await isStateChangeRelatedToActiveEvent(oldState, newState)) {
			return;
		}
		// await startTrackingUserParticipation(oldState, newState);
		return;
	}
	
	// hasUserTriggeredState(oldState, newState);
	return;
	// if (oldState.channelId === newState.channelId && (oldState.deaf == newState.deaf)) {
	// if (oldState.channelId === newState.channelId && (oldState.deaf == newState.deaf)) {
	// 	// user did not change channels
	// 	return;
	// }
	//
	// const guild: Guild = (oldState.guild != null) ? oldState.guild : newState.guild;
	// const member: GuildMember | null = (oldState.guild != null) ? oldState.member : newState.member;
	//
	// if (member == null) {
	// 	// could not find member
	// 	return;
	// }
	//
	// const db: Db = await MongoDbUtils.connect(constants.DB_NAME_DEGEN);
	// db.collection(constants.DB_COLLECTION_POAP_SETTINGS);
	//
	// const poapSettingsDB: Collection = db.collection(constants.DB_COLLECTION_POAP_SETTINGS);
	// const activeChannelsCursor: Cursor<POAPSettings> = await poapSettingsDB.find({
	// 	isActive: true,
	// 	discordServerId: `${guild.id}`,
	// });
	// for await (const poapSetting of activeChannelsCursor) {
	// 	const currentDate: Dayjs = dayjs();
	// 	try {
	// 		const endDate: Dayjs = (poapSetting.endTime == null) ? currentDate : dayjs(poapSetting.endTime);
	// 		if (currentDate.isBefore(endDate)) {
	// 			const voiceChannel: GuildChannel | null = await guild.channels.fetch(poapSetting.voiceChannelId);
	// 			if (voiceChannel == null) {
	// 				Log.warn('voice channel might have been deleted.');
	// 				return;
	// 			}
	// 			await addUserToDb(oldState, newState, db, voiceChannel, member);
	// 		} else {
	// 			Log.debug(`current date is after or equal to event end date, currentDate: ${currentDate}, endDate: ${endDate}`);
	// 			const poapOrganizerGuildMember: GuildMember = await guild.members.fetch(poapSetting.discordUserId);
	// 			await EndPOAP(poapOrganizerGuildMember, constants.PLATFORM_TYPE_DISCORD);
	// 		}
	// 	} catch (e) {
	// 		LogUtils.logError(`failed to add ${member.user.tag} to db`, e);
	// 	}
	// }
};

export const addUserToDb = async (
	oldState: VoiceState, newState: VoiceState, db: Db, channel: GuildChannel, member: GuildMember,
): Promise<any> => {
	if (!(newState.channelId === channel.id || oldState.channelId === channel.id)) {
		// event change is not related to event parameter
		return;
	}
	if (newState.deaf) {
		await updateUserForPOAP(member, db, channel, false, true).catch(e => LogUtils.logError('failed to capture user joined for poap', e));
		return;
	}
	const hasJoined: boolean = (newState.channelId === channel.id);
	await updateUserForPOAP(member, db, channel, hasJoined).catch(e => LogUtils.logError(`failed to capture user change for POAP hasJoined: ${hasJoined}`, e));
	return;
};

export const updateUserForPOAP = async (
	member: GuildMember, db: Db, channel: GuildChannel, hasJoined?: boolean, hasDeafened?: boolean,
): Promise<any> => {
	const poapParticipantsDb: Collection = db.collection(constants.DB_COLLECTION_POAP_PARTICIPANTS);
	const poapParticipant: POAPParticipant = await poapParticipantsDb.findOne({
		discordServerId: `${channel.guild.id}`,
		voiceChannelId: `${channel.id}`,
		discordUserId: `${member.user.id}`,
	});
	
	if (hasDeafened) {
		Log.debug(`${member.user.tag} | deafened themselves ${channel.name} in ${channel.guild.name}`);
		await poapParticipantsDb.deleteOne(poapParticipant).catch(Log.error);
		return;
	}
	const currentDate: Dayjs = dayjs();
	if (!hasJoined) {
		Log.debug(`${member.user.tag} | left ${channel.name} in ${channel.guild.name}`);
		const startTimeDate: Dayjs = dayjs(poapParticipant.startTime);
		let durationInMinutes: number = poapParticipant.durationInMinutes;
		if ((currentDate.unix() - startTimeDate.unix() > 0)) {
			durationInMinutes += ((currentDate.unix() - startTimeDate.unix()) / 60);
		}
		await poapParticipantsDb.updateOne(poapParticipant, {
			$set: {
				endTime: (new Date).toISOString(),
				durationInMinutes: durationInMinutes,
			},
		}).catch(Log.error);
		return;
	}
	if (poapParticipant !== null && poapParticipant.discordUserId != null && poapParticipant.discordUserId === member.user.id) {
		Log.debug(`${member.user.tag} | rejoined ${channel.name} in ${channel.guild.name}`);
		await poapParticipantsDb.updateOne(poapParticipant, {
			$set: {
				startTime: currentDate.toISOString(),
			},
			$unset: {
				endTime: null,
			},
		}).catch(Log.error);
		return;
	}
	
	const currentDateStr = (new Date()).toISOString();
	const result: InsertOneWriteOpResult<POAPParticipant> | void = await poapParticipantsDb.insertOne({
		discordUserId: `${member.user.id}`,
		discordUserTag: `${member.user.tag}`,
		startTime: currentDateStr,
		voiceChannelId: `${channel.id}`,
		discordServerId: `${channel.guild.id}`,
		durationInMinutes: 0,
	}).catch(Log.error);
	if (result == null || result.insertedCount !== 1) {
		throw new MongoError('failed to insert poapParticipant');
	}
	Log.debug(`${member.user.tag} | joined ${channel.name} in ${channel.guild.name}`);
};

const hasUserBeenDeafened = (oldState: VoiceState, newState: VoiceState): boolean => {
	return newState.deaf != null && newState.deaf && newState.deaf != oldState.deaf;
};

const hasUserEnteredChannel = (oldState: VoiceState, newState: VoiceState): boolean => {
	return newState.channelId != null && newState.channelId != oldState.channelId;
};

const isStateChangeRelatedToActiveEvent = async (oldState: VoiceState, newState: VoiceState): Promise<boolean> => {
	const db: Db = await MongoDbUtils.connect(constants.DB_NAME_DEGEN);
	const channelIdA = oldState.channelId;
	const channelIdB = newState.channelId;
	const poapSettingsDB: Collection<POAPSettings> = db.collection(constants.DB_COLLECTION_POAP_SETTINGS);
	
	if (channelIdA != null && channelIdA != '' && channelIdB != null && channelIdB != '' && channelIdA == channelIdB) {
		const activeEvent: POAPSettings | null = await poapSettingsDB.findOne({
			isActive: true,
			voiceChannelId: channelIdA.toString(),
			discordServerId: oldState.guild.id.toString(),
		});
		
		if (activeEvent != null) {
			Log.debug(`state changed related to active event, userId: ${oldState.id}, channelId: ${channelIdA}`);
			return true;
		}
	}
	
	if (channelIdB != null) {
		const activeEvent: POAPSettings | null = await poapSettingsDB.findOne({
			isActive: true,
			voiceChannelId: channelIdB.toString(),
			discordServerId: newState.guild.id.toString(),
		});
		
		if (activeEvent != null) {
			Log.debug(`state changed related to active event, userId: ${newState.id}, channelId: ${channelIdB}`);
			return true;
		}
	}
	
	Log.debug('state change not related to event');
	return false;
};

const removeDeafenedUser = async (oldState: VoiceState, newState: VoiceState) => {
	const db: Db = await MongoDbUtils.connect(constants.DB_NAME_DEGEN);
	const poapSettingsDB: Collection<POAPParticipant> = db.collection(constants.DB_COLLECTION_POAP_PARTICIPANTS);
	
	if (oldState.channelId) {
		const result: DeleteWriteOpResultObject | void = await poapSettingsDB.deleteOne({
			isActive: true,
			voiceChannelId: oldState.channelId.toString(),
			discordServerId: oldState.guild.id.toString(),
			discordUserId: oldState.id.toString(),
		}).catch(Log.warn);
		if (result != null && result.deletedCount == 1) {
			Log.debug(`user removed from db, userId: ${oldState.id} deafened themselves, channelId: ${oldState.channelId}, discordServerId: ${oldState.id}`);
		}
	}
	
	if (newState.channelId) {
		const result: DeleteWriteOpResultObject | void = await poapSettingsDB.deleteOne({
			isActive: true,
			voiceChannelId: newState.channelId.toString(),
			discordServerId: newState.guild.id.toString(),
			discordUserId: newState.id.toString(),
		}).catch(Log.warn);
		if (result != null && result.deletedCount == 1) {
			Log.debug(`user removed from db, userId: ${newState.id} deafened themselves, channelId: ${newState.channelId}, discordServerId: ${newState.id}`);
		}
	}
};

// const startTrackingUserParticipation = async (oldState: VoiceState, newState: VoiceState) => {
//	
// };
//
// const stopTrackingUserParticipation = async (oldState: VoiceState, newState: VoiceState) => {
//	
// };
//
// const hasUserTriggeredState = (oldState: VoiceState, newState: VoiceState): boolean => {
// 	// Check if user entered a channel
// 	if (newState.channelId != null && newState.channelId != oldState.channelId) {
// 		// Log.debug('entered a channel');
// 		return true;
// 	}
//
// 	// Check if user left all channels
// 	if (newState.channelId == null && newState.channelId != oldState.channelId) {
// 		// Log.debug('left all channels');
// 		return true;
// 	}
//	
// 	return false;
// 	// if (oldState.channelId === newState.channelId && (oldState.deaf == newState.deaf)) {
// 	// 	// user did not change channels
// 	// 	return false;
// 	// }
// 	// const member: GuildMember | null = (oldState.guild != null) ? oldState.member : newState.member;
// 	//
// 	// if (member == null) {
// 	// 	// could not find member
// 	// 	return false;
// 	// }
// 	// return true;
// };

export default HandleParticipantDuringEvent;