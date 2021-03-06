import { SlashCommand, CommandContext, SlashCreator } from 'slash-create';
import ServiceUtils from '../../utils/ServiceUtils';
import discordServerIds from '../../service/constants/discordServerIds';
import Log from '../../utils/Log';

export default class WalletConnect extends SlashCommand {
	constructor(creator: SlashCreator) {
		super(creator, {
			name: 'connect',
			description: 'Connect your wallet',
			guildIDs: [discordServerIds.banklessDAO, discordServerIds.discordBotGarage],
		});
	}

	async run(ctx: CommandContext): Promise<any> {
		// Ignores commands from bots
		if (ctx.user.bot) return;

		if (ctx.guildID == null) {
			await ctx.send({ content: 'Please try this command within a discord server.' });
			return;
		}

		try {
			const { guildMember } = await ServiceUtils.getGuildAndMember(ctx.guildID, ctx.user.id);
			const publicReplyStr = 'Follow this link to verify your address: https://degen.bankless.community/connect';
			const dmReplyStr = `${ctx.user.mention} Sent you a DM with information on how to connect your wallet.`;
			ctx.send({ content: dmReplyStr, ephemeral: true });
			return guildMember.send(publicReplyStr);
		} catch (e) {
			Log.error(e);
		}
	}
}
