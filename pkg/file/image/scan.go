package image

import (
	"context"
	"fmt"
	"image"

	_ "image/gif"
	_ "image/jpeg"
	_ "image/png"

	"github.com/stashapp/stash/pkg/ffmpeg"
	"github.com/stashapp/stash/pkg/file"
	"github.com/stashapp/stash/pkg/file/video"
	"github.com/stashapp/stash/pkg/logger"
	_ "golang.org/x/image/webp"
)

// Decorator adds image specific fields to a File.
type Decorator struct {
	FFProbe ffmpeg.FFProbe
}

func (d *Decorator) Decorate(ctx context.Context, fs file.FS, f file.File) (file.File, error) {
	base := f.Base()

	decorateFallback := func() (file.File, error) {
		r, err := fs.Open(base.Path)
		if err != nil {
			return f, fmt.Errorf("reading image file %q: %w", base.Path, err)
		}
		defer r.Close()

		c, format, err := image.DecodeConfig(r)
		if err != nil {
			return f, fmt.Errorf("decoding image file %q: %w", base.Path, err)
		}
		return &file.ImageFile{
			BaseFile: base,
			Format:   format,
			Width:    c.Width,
			Height:   c.Height,
		}, nil
	}

	// ignore clips in non-OsFS filesystems as ffprobe cannot read them
	// TODO - copy to temp file if not an OsFS
	if _, isOs := fs.(*file.OsFS); !isOs {
		logger.Debugf("assuming ImageFile for non-OsFS file %q", base.Path)
		return decorateFallback()
	}

	probe, err := d.FFProbe.NewVideoFile(base.Path)
	if err != nil {
		logger.Warnf("File %q could not be read with ffprobe: %s, assuming ImageFile", base.Path, err)
		return decorateFallback()
	}

	isClip := true
	// This list is derived from ffmpegImageThumbnail in pkg/image/thumbnail. If one gets updated, the other should be as well
	for _, item := range []string{"png", "mjpeg", "webp"} {
		if item == probe.VideoCodec {
			isClip = false
		}
	}
	if isClip {
		videoFileDecorator := video.Decorator{FFProbe: d.FFProbe}
		return videoFileDecorator.Decorate(ctx, fs, f)
	}

	return &file.ImageFile{
		BaseFile: base,
		Format:   probe.VideoCodec,
		Width:    probe.Width,
		Height:   probe.Height,
	}, nil
}

func (d *Decorator) IsMissingMetadata(ctx context.Context, fs file.FS, f file.File) bool {
	const (
		unsetString = "unset"
		unsetNumber = -1
	)

	imf, isImage := f.(*file.ImageFile)
	vf, isVideo := f.(*file.VideoFile)

	switch {
	case isImage:
		return imf.Format == unsetString || imf.Width == unsetNumber || imf.Height == unsetNumber
	case isVideo:
		videoFileDecorator := video.Decorator{FFProbe: d.FFProbe}
		return videoFileDecorator.IsMissingMetadata(ctx, fs, vf)
	default:
		return true
	}
}
