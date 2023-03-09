import { Client, GatewayIntentBits } from 'discord.js';
import { joinVoiceChannel, EndBehaviorType, AudioPlayerStatus, StreamType, createAudioPlayer, createAudioResource, getVoiceConnection, NoSubscriberBehavior, PlayerSubscription, AudioReceiveStream } from "@discordjs/voice";
import pkg from '@discordjs/opus';
const { OpusEncoder } = pkg;
import * as dotenv from "dotenv";
import AudioMixer from 'audio-mixer';
dotenv.config();

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.GuildVoiceStates],
});

client.on("ready", () => {
  console.log(`the bot is online!`);
});

client.on("messageCreate", (message) => {
    if(message.author.id != "501819491764666386") return;
    const voicechannel = message.member.voice.channel;
    if(!voicechannel) return message.channel.send("Please join a vc");
    joinVoiceChannel({
        channelId: voicechannel.id,
        guildId: message.guild.id,
        adapterCreator: message.guild.voiceAdapterCreator,
        selfDeaf: false,
        selfMute: false
    });

    let connection = getVoiceConnection(message.guild.id);
    let receiver = connection.receiver;
    let speakingUsers = [];
    let vcMembers = [];

    message.guild.channels.cache.get(voicechannel.id).members.forEach(member => {
        if(member.user.bot) return;
        let preparedMember = {
            username: member.user.username,
            profilePictureURL: member.user.avatarURL(),
            discriminator: member.user.discriminator
        }
        vcMembers.push(preparedMember);
    });
    
    const encoder = new OpusEncoder(48000, 2);
    let mixer = new AudioMixer.Mixer({channels: 2, bitDepth: 16, sampleRate: 48000, clearInterval: 250});

    receiver.speaking.on("start", (user) => {
        if(speakingUsers.includes(user)) return;
        playStream(user);
    });

    connection.on('stateChange', (oldState, newState) => {
        const oldNetworking = Reflect.get(oldState, 'networking');
        const newNetworking = Reflect.get(newState, 'networking');

        const networkStateChangeHandler = (oldNetworkState, newNetworkState) => {
          const newUdp = Reflect.get(newNetworkState, 'udp');
          clearInterval(newUdp?.keepAliveInterval);
        }

        oldNetworking?.off('stateChange', networkStateChangeHandler);
        newNetworking?.on('stateChange', networkStateChangeHandler);
    });

    initAudioPlayer();

    function playStream(userId) {
        if(client.users.cache.filter(x => x.bot && x.id == userId).first()) return;
        const audioStream = receiver.subscribe(userId, { end: { behavior: EndBehaviorType.AfterSilence, duration: 100 } });
        const input = mixer.input({ volume: 75 });
        speakingUsers.push(userId);
    
        audioStream
            .on("data", (chunk) => {
                input.write(encoder.decode(chunk));
            })
            .on("error", (err) => {
                console.log(err)
            })
            .on("end", () => {
                audioStream.destroy();
                mixer.removeInput(input);
                speakingUsers = speakingUsers.filter(x => x != userId);
            });
    }

    function initAudioPlayer() {
        const audioPlayer = createAudioPlayer();
        connection.subscribe(audioPlayer);
        const resource = createAudioResource(mixer, { inputType: StreamType.Raw });
        audioPlayer.play(resource);
        
        audioPlayer.on(AudioPlayerStatus.Idle, () => {
            audioPlayer.stop(true);
            mixer.destroy();
            mixer = new AudioMixer.Mixer({channels: 2, bitDepth: 16, sampleRate: 48000, clearInterval: 250});
            initAudioPlayer();
        });
    }
});

process.removeAllListeners('warning'); // I'm sorry for adding this but I kept getting warnings from the part of code with the 'stateChange' event on line 52. I believe the way I used the mixer was wrong

client.login(process.env.TOKEN);