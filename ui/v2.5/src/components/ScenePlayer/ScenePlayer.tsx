import React, {
  KeyboardEvent,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import videojs, { VideoJsPlayer, VideoJsPlayerOptions } from "video.js";
import "videojs-contrib-dash";
import "videojs-mobile-ui";
import "videojs-seek-buttons";
import { UAParser } from "ua-parser-js";
import "./live";
import "./PlaylistButtons";
import "./source-selector";
import "./persist-volume";
import "./markers";
import "./vtt-thumbnails";
import "./big-buttons";
import "./track-activity";
import "./vrmode";
import cx from "classnames";
import {
  useSceneSaveActivity,
  useSceneIncrementPlayCount,
} from "src/core/StashService";

import * as GQL from "src/core/generated-graphql";
import { ScenePlayerScrubber } from "./ScenePlayerScrubber";
import { ConfigurationContext } from "src/hooks/Config";
import {
  ConnectionState,
  InteractiveContext,
} from "src/hooks/Interactive/context";
import { SceneInteractiveStatus } from "src/hooks/Interactive/status";
import { languageMap } from "src/utils/caption";
import { VIDEO_PLAYER_ID } from "./util";
import { IUIConfig } from "src/core/config";

function handleHotkeys(player: VideoJsPlayer, event: videojs.KeyboardEvent) {
  function seekStep(step: number) {
    const time = player.currentTime() + step;
    const duration = player.duration();
    if (time < 0) {
      player.currentTime(0);
    } else if (time < duration) {
      player.currentTime(time);
    } else {
      player.currentTime(duration);
    }
  }

  function seekPercent(percent: number) {
    const duration = player.duration();
    const time = duration * percent;
    player.currentTime(time);
  }

  function seekPercentRelative(percent: number) {
    const duration = player.duration();
    const currentTime = player.currentTime();
    const time = currentTime + duration * percent;
    if (time > duration) return;
    player.currentTime(time);
  }

  let seekFactor = 10;
  if (event.shiftKey) {
    seekFactor = 5;
  } else if (event.ctrlKey || event.altKey) {
    seekFactor = 60;
  }
  switch (event.which) {
    case 39: // right arrow
      seekStep(seekFactor);
      break;
    case 37: // left arrow
      seekStep(-seekFactor);
      break;
  }

  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) {
    return;
  }

  switch (event.which) {
    case 32: // space
    case 13: // enter
      if (player.paused()) player.play();
      else player.pause();
      break;
    case 77: // m
      player.muted(!player.muted());
      break;
    case 70: // f
      if (player.isFullscreen()) player.exitFullscreen();
      else player.requestFullscreen();
      break;
    case 38: // up arrow
      player.volume(player.volume() + 0.1);
      break;
    case 40: // down arrow
      player.volume(player.volume() - 0.1);
      break;
    case 48: // 0
      player.currentTime(0);
      break;
    case 49: // 1
      seekPercent(0.1);
      break;
    case 50: // 2
      seekPercent(0.2);
      break;
    case 51: // 3
      seekPercent(0.3);
      break;
    case 52: // 4
      seekPercent(0.4);
      break;
    case 53: // 5
      seekPercent(0.5);
      break;
    case 54: // 6
      seekPercent(0.6);
      break;
    case 55: // 7
      seekPercent(0.7);
      break;
    case 56: // 8
      seekPercent(0.8);
      break;
    case 57: // 9
      seekPercent(0.9);
      break;
    case 221: // ]
      seekPercentRelative(0.1);
      break;
    case 219: // [
      seekPercentRelative(-0.1);
      break;
  }
}

type MarkerFragment = Pick<GQL.SceneMarker, "title" | "seconds"> & {
  primary_tag: Pick<GQL.Tag, "name">;
  tags: Array<Pick<GQL.Tag, "name">>;
};

function getMarkerTitle(marker: MarkerFragment) {
  if (marker.title) {
    return marker.title;
  }

  let ret = marker.primary_tag.name;
  if (marker.tags.length) {
    ret += `, ${marker.tags.map((t) => t.name).join(", ")}`;
  }

  return ret;
}

interface IScenePlayerProps {
  scene: GQL.SceneDataFragment | undefined | null;
  hideScrubberOverride: boolean;
  autoplay?: boolean;
  permitLoop?: boolean;
  initialTimestamp: number;
  sendSetTimestamp: (setTimestamp: (value: number) => void) => void;
  onComplete: () => void;
  onNext: () => void;
  onPrevious: () => void;
}

export const ScenePlayer: React.FC<IScenePlayerProps> = ({
  scene,
  hideScrubberOverride,
  autoplay,
  permitLoop = true,
  initialTimestamp: _initialTimestamp,
  sendSetTimestamp,
  onComplete,
  onNext,
  onPrevious,
}) => {
  const { configuration } = useContext(ConfigurationContext);
  const interfaceConfig = configuration?.interface;
  const uiConfig = configuration?.ui as IUIConfig | undefined;
  const videoRef = useRef<HTMLDivElement>(null);
  const [_player, setPlayer] = useState<VideoJsPlayer>();
  const sceneId = useRef<string>();
  const [sceneSaveActivity] = useSceneSaveActivity();
  const [sceneIncrementPlayCount] = useSceneIncrementPlayCount();

  const [time, setTime] = useState(0);
  const [ready, setReady] = useState(false);

  const {
    interactive: interactiveClient,
    uploadScript,
    currentScript,
    initialised: interactiveInitialised,
    state: interactiveState,
  } = React.useContext(InteractiveContext);

  const [fullscreen, setFullscreen] = useState(false);
  const [showScrubber, setShowScrubber] = useState(false);

  const initialTimestamp = useRef(-1);
  const started = useRef(false);
  const auto = useRef(false);
  const interactiveReady = useRef(false);

  const minimumPlayPercent = uiConfig?.minimumPlayPercent ?? 0;
  const trackActivity = uiConfig?.trackActivity ?? false;
  const vrTag = uiConfig?.vrTag ?? undefined;

  const file = useMemo(
    () => ((scene?.files.length ?? 0) > 0 ? scene?.files[0] : undefined),
    [scene]
  );

  const maxLoopDuration = interfaceConfig?.maximumLoopDuration ?? 0;
  const looping = useMemo(
    () =>
      !!file?.duration &&
      permitLoop &&
      maxLoopDuration !== 0 &&
      file.duration < maxLoopDuration,
    [file, permitLoop, maxLoopDuration]
  );

  const getPlayer = useCallback(() => {
    if (!_player) return null;
    if (_player.isDisposed()) return null;
    return _player;
  }, [_player]);

  useEffect(() => {
    if (hideScrubberOverride || fullscreen) {
      setShowScrubber(false);
      return;
    }

    const onResize = () => {
      const show = window.innerHeight >= 450 && window.innerWidth >= 576;
      setShowScrubber(show);
    };
    onResize();

    window.addEventListener("resize", onResize);

    return () => window.removeEventListener("resize", onResize);
  }, [hideScrubberOverride, fullscreen]);

  useEffect(() => {
    sendSetTimestamp((value: number) => {
      const player = getPlayer();
      if (player && value >= 0) {
        player.play()?.then(() => {
          player.currentTime(value);
        });
      }
    });
  }, [sendSetTimestamp, getPlayer]);

  // Initialize VideoJS player
  useEffect(() => {
    const options: VideoJsPlayerOptions = {
      id: VIDEO_PLAYER_ID,
      controls: true,
      controlBar: {
        pictureInPictureToggle: false,
        volumePanel: {
          inline: false,
        },
        chaptersButton: false,
      },
      html5: {
        dash: {
          updateSettings: [
            {
              streaming: {
                buffer: {
                  bufferTimeAtTopQuality: 30,
                  bufferTimeAtTopQualityLongForm: 30,
                },
                gaps: {
                  jumpGaps: false,
                  jumpLargeGaps: false,
                },
              },
            },
          ],
        },
      },
      nativeControlsForTouch: false,
      playbackRates: [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2],
      inactivityTimeout: 2000,
      preload: "none",
      playsinline: true,
      userActions: {
        hotkeys: function (this: VideoJsPlayer, event) {
          handleHotkeys(this, event);
        },
      },
      plugins: {
        vttThumbnails: {
          showTimestamp: true,
        },
        markers: {},
        sourceSelector: {},
        persistVolume: {},
        bigButtons: {},
        seekButtons: {
          forward: 10,
          back: 10,
        },
        skipButtons: {},
        trackActivity: {},
        vrMenu: {},
      },
    };

    const videoEl = document.createElement("video-js");
    videoEl.setAttribute("data-vjs-player", "true");
    videoEl.setAttribute("crossorigin", "anonymous");
    videoEl.classList.add("vjs-big-play-centered");
    videoRef.current!.appendChild(videoEl);

    const vjs = videojs(videoEl, options);

    /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
    const settings = (vjs as any).textTrackSettings;
    settings.setValues({
      backgroundColor: "#000",
      backgroundOpacity: "0.5",
    });
    settings.updateDisplay();

    vjs.focus();
    setPlayer(vjs);

    // Video player destructor
    return () => {
      vjs.dispose();
      videoEl.remove();
      setPlayer(undefined);

      // reset sceneId to force reload sources
      sceneId.current = undefined;
    };
    // empty deps - only init once
  }, []);

  useEffect(() => {
    const player = getPlayer();
    if (!player) return;
    const skipButtons = player.skipButtons();
    skipButtons.setForwardHandler(onNext);
    skipButtons.setBackwardHandler(onPrevious);
  }, [getPlayer, onNext, onPrevious]);

  useEffect(() => {
    if (scene?.interactive && interactiveInitialised) {
      interactiveReady.current = false;
      uploadScript(scene.paths.funscript || "").then(() => {
        interactiveReady.current = true;
      });
    }
  }, [
    uploadScript,
    interactiveInitialised,
    scene?.interactive,
    scene?.paths.funscript,
  ]);

  useEffect(() => {
    const player = getPlayer();
    if (!player) return;

    const vrMenu = player.vrMenu();

    let showButton = false;

    if (scene && vrTag) {
      showButton = scene.tags.some((tag) => vrTag === tag.name);
    }

    vrMenu.setShowButton(showButton);
  }, [getPlayer, scene, vrTag]);

  // Player event handlers
  useEffect(() => {
    const player = getPlayer();
    if (!player) return;

    function canplay(this: VideoJsPlayer) {
      if (initialTimestamp.current !== -1) {
        this.currentTime(initialTimestamp.current);
        initialTimestamp.current = -1;
      }
    }

    function playing(this: VideoJsPlayer) {
      // This still runs even if autoplay failed on Safari,
      // only set flag if actually playing
      if (!started.current && !this.paused()) {
        started.current = true;
      }
    }

    function loadstart(this: VideoJsPlayer) {
      setReady(true);
    }

    function fullscreenchange(this: VideoJsPlayer) {
      setFullscreen(this.isFullscreen());
    }

    player.on("canplay", canplay);
    player.on("playing", playing);
    player.on("loadstart", loadstart);
    player.on("fullscreenchange", fullscreenchange);

    return () => {
      player.off("canplay", canplay);
      player.off("playing", playing);
      player.off("loadstart", loadstart);
      player.off("fullscreenchange", fullscreenchange);
    };
  }, [getPlayer]);

  useEffect(() => {
    const player = getPlayer();
    if (!player) return;

    function onplay(this: VideoJsPlayer) {
      this.persistVolume().enabled = true;
      if (scene?.interactive && interactiveReady.current) {
        interactiveClient.play(this.currentTime());
      }
    }

    function pause(this: VideoJsPlayer) {
      interactiveClient.pause();
    }

    function seeking(this: VideoJsPlayer) {
      if (this.paused()) return;
      if (scene?.interactive && interactiveReady.current) {
        interactiveClient.play(this.currentTime());
      }
    }

    function timeupdate(this: VideoJsPlayer) {
      if (this.paused()) return;
      if (scene?.interactive && interactiveReady.current) {
        interactiveClient.ensurePlaying(this.currentTime());
      }
      setTime(this.currentTime());
    }

    player.on("play", onplay);
    player.on("pause", pause);
    player.on("seeking", seeking);
    player.on("timeupdate", timeupdate);

    return () => {
      player.off("play", onplay);
      player.off("pause", pause);
      player.off("seeking", seeking);
      player.off("timeupdate", timeupdate);
    };
  }, [getPlayer, interactiveClient, scene]);

  useEffect(() => {
    const player = getPlayer();
    if (!player) return;

    // don't re-initialise the player unless the scene has changed
    if (!scene || !file || scene.id === sceneId.current) return;

    sceneId.current = scene.id;

    setReady(false);

    // reset on new scene
    player.trackActivity().reset();

    // always stop the interactive client on initialisation
    interactiveClient.pause();
    interactiveReady.current = false;

    const isLandscape = file.height && file.width && file.width > file.height;
    const mobileUiOptions = {
      fullscreen: {
        enterOnRotate: true,
        exitOnRotate: true,
        lockOnRotate: true,
        lockToLandscapeOnEnter: isLandscape,
      },
      touchControls: {
        disabled: true,
      },
    };
    player.mobileUi(mobileUiOptions);

    function isDirect(src: URL) {
      return (
        src.pathname.endsWith("/stream") ||
        src.pathname.endsWith("/stream.mpd") ||
        src.pathname.endsWith("/stream.m3u8")
      );
    }

    const { duration } = file;
    const sourceSelector = player.sourceSelector();
    const isSafari = UAParser().browser.name?.includes("Safari");
    sourceSelector.setSources(
      scene.sceneStreams
        .filter((stream) => {
          const src = new URL(stream.url);
          const isFileTranscode = !isDirect(src);

          return !(isFileTranscode && isSafari);
        })
        .map((stream) => {
          const src = new URL(stream.url);

          return {
            src: stream.url,
            type: stream.mime_type ?? undefined,
            label: stream.label ?? undefined,
            offset: !isDirect(src),
            duration,
          };
        })
    );

    function getDefaultLanguageCode() {
      let languageCode = window.navigator.language;

      if (languageCode.indexOf("-") !== -1) {
        languageCode = languageCode.split("-")[0];
      }

      if (languageCode.indexOf("_") !== -1) {
        languageCode = languageCode.split("_")[0];
      }

      return languageCode;
    }

    if (scene.captions && scene.captions.length > 0) {
      const languageCode = getDefaultLanguageCode();
      let hasDefault = false;

      for (let caption of scene.captions) {
        const lang = caption.language_code;
        let label = lang;
        if (languageMap.has(lang)) {
          label = languageMap.get(lang)!;
        }

        label = label + " (" + caption.caption_type + ")";
        const setAsDefault = !hasDefault && languageCode == lang;
        if (setAsDefault) {
          hasDefault = true;
        }
        sourceSelector.addTextTrack(
          {
            src: `${scene.paths.caption}?lang=${lang}&type=${caption.caption_type}`,
            kind: "captions",
            srclang: lang,
            label: label,
            default: setAsDefault,
          },
          false
        );
      }
    }

    auto.current =
      autoplay ||
      (interfaceConfig?.autostartVideo ?? false) ||
      _initialTimestamp > 0;

    const alwaysStartFromBeginning =
      uiConfig?.alwaysStartFromBeginning ?? false;
    const resumeTime = scene.resume_time ?? 0;

    let startPosition = _initialTimestamp;
    if (
      !startPosition &&
      !alwaysStartFromBeginning &&
      file.duration > resumeTime
    ) {
      startPosition = resumeTime;
    }

    initialTimestamp.current = startPosition;
    setTime(startPosition);

    player.load();
    player.focus();

    player.ready(() => {
      player.vttThumbnails().src(scene.paths.vtt ?? null);
    });

    started.current = false;

    return () => {
      // stop the interactive client
      interactiveClient.pause();
    };
  }, [
    getPlayer,
    file,
    scene,
    interactiveClient,
    autoplay,
    interfaceConfig?.autostartVideo,
    uiConfig?.alwaysStartFromBeginning,
    _initialTimestamp,
  ]);

  useEffect(() => {
    const player = getPlayer();
    if (!player || !scene) return;

    const markers = player.markers();
    markers.clearMarkers();
    for (const marker of scene.scene_markers) {
      markers.addMarker({
        title: getMarkerTitle(marker),
        time: marker.seconds,
      });
    }

    if (scene.paths.screenshot) {
      player.poster(scene.paths.screenshot);
    } else {
      player.poster("");
    }
  }, [getPlayer, scene]);

  useEffect(() => {
    const player = getPlayer();
    if (!player) return;

    async function saveActivity(resumeTime: number, playDuration: number) {
      if (!scene?.id) return;

      await sceneSaveActivity({
        variables: {
          id: scene.id,
          playDuration,
          resume_time: resumeTime,
        },
      });
    }

    async function incrementPlayCount() {
      if (!scene?.id) return;

      await sceneIncrementPlayCount({
        variables: {
          id: scene.id,
        },
      });
    }

    const activity = player.trackActivity();
    activity.saveActivity = saveActivity;
    activity.incrementPlayCount = incrementPlayCount;
    activity.minimumPlayPercent = minimumPlayPercent;
    activity.setEnabled(trackActivity);
  }, [
    getPlayer,
    scene,
    vrTag,
    trackActivity,
    minimumPlayPercent,
    sceneIncrementPlayCount,
    sceneSaveActivity,
  ]);

  useEffect(() => {
    const player = getPlayer();
    if (!player) return;

    player.loop(looping);
    interactiveClient.setLooping(looping);
  }, [getPlayer, interactiveClient, looping]);

  useEffect(() => {
    const player = getPlayer();
    if (!player || !scene || !ready || !auto.current) {
      return;
    }

    // check if we're waiting for the interactive client
    if (
      scene.interactive &&
      interactiveClient.handyKey &&
      currentScript !== scene.paths.funscript
    ) {
      return;
    }

    player.play()?.catch(() => {
      // Browser probably blocking non-muted autoplay, so mute and try again
      player.persistVolume().enabled = false;
      player.muted(true);

      player.play();
    });
    auto.current = false;
  }, [getPlayer, scene, ready, interactiveClient, currentScript]);

  // Attach handler for onComplete event
  useEffect(() => {
    const player = getPlayer();
    if (!player) return;

    player.on("ended", onComplete);

    return () => player.off("ended");
  }, [getPlayer, onComplete]);

  function onScrubberScroll() {
    if (started.current) {
      getPlayer()?.pause();
    }
  }

  function onScrubberSeek(seconds: number) {
    if (started.current) {
      getPlayer()?.currentTime(seconds);
    } else {
      initialTimestamp.current = seconds;
      setTime(seconds);
    }
  }

  // Override spacebar to always pause/play
  function onKeyDown(this: HTMLDivElement, event: KeyboardEvent) {
    const player = getPlayer();
    if (!player) return;

    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) {
      return;
    }
    if (event.key == " ") {
      event.preventDefault();
      event.stopPropagation();
      if (player.paused()) {
        player.play();
      } else {
        player.pause();
      }
    }
  }

  const isPortrait =
    scene && file && file.height && file.width && file.height > file.width;

  return (
    <div
      className={cx("VideoPlayer", { portrait: isPortrait })}
      onKeyDownCapture={onKeyDown}
    >
      <div className="video-wrapper" ref={videoRef} />
      {scene?.interactive &&
        (interactiveState !== ConnectionState.Ready ||
          getPlayer()?.paused()) && <SceneInteractiveStatus />}
      {scene && file && showScrubber && (
        <ScenePlayerScrubber
          file={file}
          scene={scene}
          time={time}
          onSeek={onScrubberSeek}
          onScroll={onScrubberScroll}
        />
      )}
    </div>
  );
};

export default ScenePlayer;
