import { DMChannel, GuildChannel, GuildMember, MessageAttachment } from 'discord.js';
import { Collection, Collection as MongoCollection, Cursor, Db, UpdateWriteOpResult } from 'mongodb';
import constants from '../service/constants/constants';
import { POAPParticipant } from '../types/poap/POAPParticipant';
import axios from 'axios';
import ValidationError from '../errors/ValidationError';
import { POAPAdmin } from '../types/poap/POAPAdmin';
import Log, { LogUtils } from './Log';
import dayjs, { Dayjs } from 'dayjs';
import DateUtils from './DateUtils';
import { CommandContext } from 'slash-create';
import MongoDbUtils from './MongoDbUtils';
import ServiceUtils from './ServiceUtils';
import { POAPTwitterParticipants } from '../types/poap/POAPTwitterParticipants';

export type POAPFileParticipantExt = {
	discordUserId: string,
	discordUserTag: string,
	durationInMinutes?: string,
	poapLink?: string
}

export type TwitterPOAPFileParticipant = {
	twitterUserId: string,
	checkInDateISO: string,
}

const POAPUtils = {
	
	async getListOfParticipants(db: Db, voiceChannel: GuildChannel): Promise<POAPFileParticipantExt[]> {
		const poapParticipants: MongoCollection = db.collection(constants.DB_COLLECTION_POAP_PARTICIPANTS);
		const resultCursor: Cursor<POAPParticipant> = await poapParticipants.find({
			voiceChannelId: voiceChannel.id,
			discordServerId: voiceChannel.guild.id,
		});

		if ((await resultCursor.count()) === 0) {
			Log.debug(`no participants found for ${voiceChannel.name} in ${voiceChannel.guild.name}`);
			return [];
		}
		
		await POAPUtils.setEndDateForPresentParticipants(poapParticipants, resultCursor);

		const participants = [];
		await resultCursor.forEach((participant: POAPParticipant) => {
			const endTime = new Date(participant.endTime).getTime();
			let durationInMinutes: number = (endTime - (new Date(participant.startTime)).getTime());
			durationInMinutes = (durationInMinutes <= 0) ? 0 : durationInMinutes / (1000 * 60);
			if (durationInMinutes >= constants.POAP_REQUIRED_PARTICIPATION_DURATION) {
				participants.push({
					id: participant.discordUserId,
					tag: participant.discordUserTag,
					duration: durationInMinutes,
				});
			}
		});
		return participants;
	},
	
	async getListOfTwitterParticipants(db: Db, twitterSpaceId: string): Promise<TwitterPOAPFileParticipant[]> {
		const poapParticipants: MongoCollection<POAPTwitterParticipants> = db.collection(constants.DB_COLLECTION_POAP_TWITTER_PARTICIPANTS);
		const result: Cursor<POAPTwitterParticipants> = await poapParticipants.find({
			twitterSpaceId: twitterSpaceId,
		});
		if ((await result.count()) === 0) {
			Log.debug(`no participants found for twitter space: ${twitterSpaceId}`);
			return [];
		}
		Log.debug(`found participants for twitter space event: ${twitterSpaceId}`);
		const participants = [];
		await result.forEach((participant: POAPTwitterParticipants) => {
			participants.push({
				twitterId: participant.twitterUserId,
				checkInDateISO: participant.checkInDateISO,
			});
		});
		Log.debug(`prepared ${participants.length} participants`);
		return participants;
	},
	
	async setEndDateForPresentParticipants(poapParticipantsCollection: MongoCollection, poapParticipantsCursor: Cursor<POAPParticipant>): Promise<void> {
		Log.debug('starting to set endDate for present participants in db');
		const currentDateStr = dayjs().toISOString();
		for await (const participant of poapParticipantsCursor) {
			if (participant.endTime != null) {
				// skip setting endDate for present endTime;
				continue;
			}
			let result: UpdateWriteOpResult;
			try {
				result = await poapParticipantsCollection.updateOne(participant, {
					$set: {
						endTime: currentDateStr,
					},
				});
			} catch (e) {
				LogUtils.logError('failed to update poap participants with endTime', e);
			}
			if (result == null) {
				throw new Error('Mongodb operation failed');
			}
		}
		Log.debug('finished setting endDate for present participants in db');
	},

	async sendOutPOAPLinks(
		guildMember: GuildMember, listOfParticipants: POAPFileParticipantExt[], attachment: MessageAttachment, event?: string,
	): Promise<POAPFileParticipantExt[]> {
		let listOfPOAPLinks;
		const failedPOAPsList: POAPFileParticipantExt[] = [];
		const guildName = guildMember.guild.name;
		event = (event == null) ? 'event' : event;
		try {
			const response = await axios.get(attachment.url);
			listOfPOAPLinks = response.data.split('\n');
		} catch (e) {
			LogUtils.logError('failed to process links.txt file', e);
			await guildMember.send({ content: 'Could not process the links.txt file. Please make sure the file that is uploaded has every URL on a new line.' });
			return;
		}
		for (let i = 0; i < listOfParticipants.length; i++) {
			try {
				if (listOfPOAPLinks[i] == null || listOfPOAPLinks[i] == '') {
					failedPOAPsList.push({
						discordUserId: listOfParticipants[i].discordUserId,
						discordUserTag: listOfParticipants[i].discordUserTag,
						poapLink: 'n/a',
					});
					continue;
				}
				await guildMember.guild.members.fetch(listOfParticipants[i].discordUserId)
					.then(async (participantMember: GuildMember) => {
						await participantMember.send({ content: `Thank you for participating in the ${event} from ${guildName}! Here is your POAP: ${listOfPOAPLinks[i]}` }).catch((e) => {
							failedPOAPsList.push({
								discordUserId: listOfParticipants[i].discordUserId,
								discordUserTag: listOfParticipants[i].discordUserTag,
								poapLink: listOfPOAPLinks[i],
							});
							LogUtils.logError(`failed trying to send POAP to: ${listOfParticipants[i].discordUserId}, userTag: ${listOfParticipants[i].discordUserTag}, link: ${listOfPOAPLinks[i]}`, e);
						});
					}).catch(async (e) => {
						LogUtils.logError(`failed trying to find: ${listOfParticipants[i].discordUserId}, userTag: ${listOfParticipants[i].discordUserTag}, to give link ${listOfPOAPLinks[i]}`, e);
						const tryAgainMember: GuildMember = await guildMember.guild.members.fetch(listOfParticipants[i].discordUserId);
						Log.debug(`trying to send another message to user ${listOfParticipants[i].discordUserTag}`);
						await tryAgainMember.send({ content: `Thank you for participating in the ${event} from ${guildName}! Here is your POAP: ${listOfPOAPLinks[i]}` }).catch((e2) => {
							failedPOAPsList.push({ discordUserId: listOfParticipants[i].discordUserId, discordUserTag: listOfParticipants[i].discordUserTag, poapLink: listOfPOAPLinks[i] });
							LogUtils.logError(`failed trying to send POAP to: ${listOfParticipants[i].discordUserId}, userTag: ${listOfParticipants[i].discordUserTag}, link: ${listOfPOAPLinks[i]}`, e2);
						});
					});
			} catch (e) {
				LogUtils.logError('user might have been banned or has DMs off', e);
				failedPOAPsList.push({ discordUserId: listOfParticipants[i].discordUserId, discordUserTag: listOfParticipants[i].discordUserTag, poapLink: listOfPOAPLinks[i] });
			}
		}
		Log.info(`Links sent to ${listOfParticipants.length - failedPOAPsList.length} participants.`);
		return failedPOAPsList;
	},
	
	async sendOutFailedPOAPLinks(
		guildMember: GuildMember, listOfFailedParticipants: POAPFileParticipantExt[], event?: string,
	): Promise<POAPFileParticipantExt[]> {
		const failedPOAPsList: POAPFileParticipantExt[] = [];
		const guildName = guildMember.guild.name;
		event = (event == null) ? 'event' : event;
		for (let i = 0; i < listOfFailedParticipants.length; i++) {
			try {
				if (listOfFailedParticipants[i].poapLink == null || listOfFailedParticipants[i].poapLink == '') {
					failedPOAPsList.push({
						discordUserId: listOfFailedParticipants[i].discordUserId,
						discordUserTag: listOfFailedParticipants[i].discordUserTag,
						poapLink: 'n/a',
					});
					continue;
				}
				await guildMember.guild.members.fetch(listOfFailedParticipants[i].discordUserId)
					.then(async (participantMember: GuildMember) => {
						await participantMember.send({ content: `Thank you for participating in the ${event} from ${guildName}! Here is your POAP: ${listOfFailedParticipants[i].poapLink}` }).catch((e) => {
							failedPOAPsList.push({
								discordUserId: listOfFailedParticipants[i].discordUserId,
								discordUserTag: listOfFailedParticipants[i].discordUserTag,
								poapLink: listOfFailedParticipants[i].poapLink,
							});
							LogUtils.logError(`failed trying to send POAP to: ${listOfFailedParticipants[i].discordUserId}, userTag: ${listOfFailedParticipants[i].discordUserTag}, link: ${listOfFailedParticipants[i].poapLink}`, e);
						});
					}).catch(async (e) => {
						LogUtils.logError(`failed trying to find: ${listOfFailedParticipants[i].discordUserId}, userTag: ${listOfFailedParticipants[i].discordUserTag}, to give link ${listOfFailedParticipants[i].poapLink}`, e);
						const tryAgainMember: GuildMember = await guildMember.guild.members.fetch(listOfFailedParticipants[i].discordUserId);
						Log.debug(`trying to send another message to user ${listOfFailedParticipants[i].discordUserTag}`);
						await tryAgainMember.send({ content: `Thank you for participating in the ${event} from ${guildName}! Here is your POAP: ${listOfFailedParticipants[i].poapLink}` }).catch((e2) => {
							failedPOAPsList.push({ discordUserId: listOfFailedParticipants[i].discordUserId, discordUserTag: listOfFailedParticipants[i].discordUserTag, poapLink: listOfFailedParticipants[i].poapLink });
							LogUtils.logError(`failed trying to send POAP to: ${listOfFailedParticipants[i].discordUserId}, userTag: ${listOfFailedParticipants[i].discordUserTag}, link: ${listOfFailedParticipants[i].poapLink}`, e2);
						});
					});
			} catch (e) {
				LogUtils.logError('user might have been banned or has DMs off', e);
				failedPOAPsList.push({ discordUserId: listOfFailedParticipants[i].discordUserId, discordUserTag: listOfFailedParticipants[i].discordUserTag, poapLink: listOfFailedParticipants[i].poapLink });
			}
		}
		Log.info(`Links sent to ${listOfFailedParticipants.length - failedPOAPsList.length} participants.`);
		return failedPOAPsList;
	},
	
	async setupFailedAttendeesDelivery(
		guildMember: GuildMember, listOfFailedPOAPs: POAPFileParticipantExt[], event: string, ctx?: CommandContext,
	): Promise<any> {
		Log.debug(`${listOfFailedPOAPs.length} poaps failed to deliver`);
		await guildMember.send({
			content: 'Looks like some degens didn\'t make it... I can setup a claim for them, all they need to do is `/poap claim`',
		});
		const db: Db = await MongoDbUtils.connect(constants.DB_NAME_DEGEN);
		const unclaimedCollection: Collection = db.collection(constants.DB_COLLECTION_POAP_UNCLAIMED_PARTICIPANTS);
		const unclaimedPOAPsList: any[] = listOfFailedPOAPs.map((failedAttendee: POAPFileParticipantExt) => {
			return {
				event: event,
				discordUserId: `${failedAttendee.discordUserId}`,
				discordUserTag: failedAttendee.discordUserTag,
				discordServerId: `${guildMember.guild.id}`,
				discordServerName: guildMember.guild.name,
				poapLink: `${failedAttendee.poapLink}`,
				expiresAt: (dayjs().add(1, 'month')).toISOString(),
			};
		});
		Log.debug('attempting to store failed attendees into db');
		await unclaimedCollection.insertMany(unclaimedPOAPsList);
		Log.debug('stored poap claims for failed degens');
		if (ctx) {
			await ctx.send('POAPs sent! Some didn\'t make it... they can claim it with `/poap claim`');
		}
		await guildMember.send({ content: 'POAP claiming setup!' });
	},

	validateEvent(event?: string): void {
		if (event == null) {
			return;
		}
		const POAP_EVENT_REGEX = /^[\w\s\W]{1,250}$/;
		if (!POAP_EVENT_REGEX.test(event)) {
			throw new ValidationError(
				'Please enter a valid event: \n' +
				'- 250 characters maximum\n ' +
				'- alphanumeric\n ' +
				'- special characters: .!@#$%&,?');
		}
	},
	
	validateNumberToMint(numberToMint: number): void {
		if (numberToMint >= 1000 || numberToMint <= 0) {
			throw new ValidationError('A maximum of 1000 POAPs can be minted for a single event. Please let us know if you\'d like to see this increased. ');
		}
	},

	validateDuration(duration?: number): void {
		if (duration == null) {
			return;
		}
		if (duration > constants.POAP_MAX_DURATION_MINUTES || duration < constants.POAP_REQUIRED_PARTICIPATION_DURATION) {
			throw new ValidationError(`Please try a value greater than ${constants.POAP_REQUIRED_PARTICIPATION_DURATION} and less than ${constants.POAP_MAX_DURATION_MINUTES} minutes.`);
		}
	},
	
	async validateUserAccess(guildMember: GuildMember, db: Db): Promise<any> {
		const poapAdminsDb: Collection = await db.collection(constants.DB_COLLECTION_POAP_ADMINS);
		const userResult: POAPAdmin = await poapAdminsDb.findOne({
			objectType: 'USER',
			discordObjectId: guildMember.user.id,
			discordServerId: guildMember.guild.id,
		});
		if (userResult != null) {
			// user has access
			return;
		}
		const rolesCursor: Cursor<POAPAdmin> = await poapAdminsDb.find({
			objectType: 'ROLE',
			discordServerId: guildMember.guild.id,
		});
		for await (const poapRole of rolesCursor) {
			if (guildMember.roles.cache.some(role => role.id === poapRole.discordObjectId)) {
				// role has access
				return;
			}
		}
		throw new ValidationError('Only authorized users can use this command. Please reach out to an admin for configuration help.');
	},
	
	validateClaimCode(code: string): void {
		if (code == null) {
			return;
		}
		const POAP_CODE_REGEX = /^[\w\s\W]{1,30}$/;
		if (!POAP_CODE_REGEX.test(code)) {
			throw new ValidationError('Please enter a claim code between 1 and 30 alphanumeric characters.');
		}
		Log.debug('user provided valid claim code');
	},
	
	getDateString(date: Dayjs): string {
		return date.format('MM-DD-YYYY');
	},
	
	getExpiryDate(date: string): string {
		try {
			const dateObject: Dayjs = DateUtils.getDate(date);
			return dateObject.add(1, 'month').format('MM-DD-YYYY');
		} catch (e) {
			LogUtils.logError('failed to parse expiry date', e);
			throw new Error('processing failed');
		}
	},
	
	getEventYear(startDateObj: Dayjs): string {
		return startDateObj.year().toString();
	},
	
	async askForDuration(guildMember: GuildMember, duration?: number): Promise<number> {
		const dmChannel: DMChannel = await guildMember.createDM();
		if (duration == null) {
			Log.debug(`asking ${guildMember.user.tag} for duration`);
			await guildMember.send({ content: 'Would you like to set the duration of the event? `(y/n)`' });
			const setDurationFlag = (await ServiceUtils.getFirstUserReply(dmChannel)) == 'y';
			Log.debug(`isAutoEnd: ${setDurationFlag}`);
			if (setDurationFlag) {
				try {
					await guildMember.send({ content: `How long should the event stay active? \`(max: ${constants.POAP_MAX_DURATION_MINUTES} minutes)\`` });
					const durationOfEventInMinutes: string = await ServiceUtils.getFirstUserReply(dmChannel);
					duration = Number(durationOfEventInMinutes);
					POAPUtils.validateDuration(duration);
				} catch (e) {
					LogUtils.logError('failed to process duration time', e);
					throw new ValidationError('Please try another duration amount as a number. i.e 15');
				}
			} else {
				Log.debug('max duration set for poap event');
				duration = constants.POAP_MAX_DURATION_MINUTES;
			}
			Log.debug(`poap event duration: ${duration}, `, {
				indexMeta: true,
				meta: {
					discordId: guildMember.guild.id,
					discordUserId: guildMember.guild.id,
				},
			});
		}
		Log.debug(`duration set for ${duration} minutes`);
		return duration;
	},
};

export default POAPUtils;