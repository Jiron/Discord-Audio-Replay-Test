import { pipeline, Readable, Transform, TransformCallback } from 'node:stream';
import { Client, GatewayIntentBits, ChannelType } from 'discord.js';
import { joinVoiceChannel, EndBehaviorType, StreamType, createAudioPlayer, createAudioResource, NoSubscriberBehavior, VoiceConnection } from "@discordjs/voice";
import { config as configDotEnv } from "dotenv";
import AudioMixer, { MixerArguments } from 'audio-mixer';
import DiscordOpus from '@discordjs/opus';

configDotEnv();

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.GuildVoiceStates],
});

client.on("ready", () => {
  console.log(`the bot is online!`);
});

let connection: VoiceConnection | undefined = undefined;

client.on("messageCreate", (message) => {
  // if(message.author.id != "501819491764666386") return;

  const { guild, member, channel } = message;

  if (!guild) {
    return;
  }

  if (!member) {
    return;
  }

  if (channel.type !== ChannelType.GuildText) {
    return;
  }

  const voiceChannel = member.voice.channel;

  if (!voiceChannel) {
    return;
  }

  if (message.content !== '!join') {
    return;
  }

  if (connection && connection.joinConfig.channelId !== voiceChannel.id) {
    connection.destroy();
  }

  connection = joinVoiceChannel({
    channelId: voiceChannel.id,
    guildId: guild.id,
    adapterCreator: guild.voiceAdapterCreator,
    selfDeaf: false,
    selfMute: false
  });

  let receiver = connection.receiver;
  const speakingUsers = new Set<string>();

  // const vcMembers = voicechannel.members.filter(m => !m.user.bot).map(member => {
  //     return {
  //         username: member.user.username,
  //         profilePictureURL: member.user.avatarURL(),
  //         discriminator: member.user.discriminator
  //     }
  // });

  let mixer = new AudioMixer.Mixer(
    { channels: 2, bitDepth: 16, sampleRate: 48000, clearInterval: 250 } as MixerArguments
  );

  for (const user of receiver.speaking.users.keys()) {
    if (!speakingUsers.has(user)) {
      playStream(user);
    }

  }

  receiver.speaking.on("start", (user) => {
    if (speakingUsers.has(user)) {
      return;
    }

    playStream(user);
  });

  const networkStateChangeHandler = (oldNetworkState: any, newNetworkState: any) => {
    const newUdp = Reflect.get(newNetworkState, 'udp');
    clearInterval(newUdp?.keepAliveInterval);
  }  

  connection.on('stateChange', (oldState, newState) => {
    const oldNetworking = Reflect.get(oldState, 'networking');
    const newNetworking = Reflect.get(newState, 'networking');

    oldNetworking?.off('stateChange', networkStateChangeHandler);
    newNetworking?.on('stateChange', networkStateChangeHandler);
  });

  initAudioPlayer();

  function playStream(userId: string) {
    if (speakingUsers.has(userId)) {
      return;
    }

    speakingUsers.add(userId);

    const audioStream = receiver.subscribe(userId, { end: { behavior: EndBehaviorType.AfterInactivity, duration: 100 } });

    const input = pipeline(
      new BufferedStream(2),
      mixer.input({ volume: 75 }),
      () => void 0
    );

    pipeline(
      audioStream,
      new OpusDecoderStream(new DiscordOpus.OpusEncoder(48000, 2)),
      new BufferedStream(4), input,
      () => void 0
    );

    audioStream.once("end", () => {
      console.log('userId', userId, 'end');

      audioStream.destroy();
      mixer.removeInput(input);
      speakingUsers.delete(userId);
    });
  }

  function initAudioPlayer() {
    const audioPlayer = createAudioPlayer({
      behaviors: {
        maxMissedFrames: 1000,
        noSubscriber: NoSubscriberBehavior.Play
      }
    });
    connection?.subscribe(audioPlayer);
    const resource = createAudioResource(mixer as unknown as Readable, { inputType: StreamType.Raw });
    audioPlayer.play(resource);
  }
});

client.login(process.env.TOKEN);

class OpusDecoderStream extends Transform {
  constructor(private opus: DiscordOpus.OpusEncoder) {
    super({
      writableObjectMode: true,
      readableObjectMode: false
    });
  }

  _transform(opusPacket: Buffer, encoding: BufferEncoding, done: TransformCallback) {
    this.push(this.opus.decode(opusPacket));
    done();
  }
}

class BufferedStream extends Transform {
  private blocks: Buffer[] = [];

  constructor(private numBlocks: number) {
    super();
  }

  _transform(pcm: Buffer, encoding: BufferEncoding, done: TransformCallback) {
    this.blocks.push(pcm);

    while (this.blocks.length >= this.numBlocks) {
      this.push(this.blocks.shift());
    }

    done();
  }
}