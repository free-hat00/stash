package studio

import (
	"context"
	"errors"
	"fmt"

	"github.com/stashapp/stash/pkg/hash/md5"
	"github.com/stashapp/stash/pkg/models"
	"github.com/stashapp/stash/pkg/models/jsonschema"
	"github.com/stashapp/stash/pkg/utils"
)

type NameFinderCreatorUpdater interface {
	NameFinderCreator
	Update(ctx context.Context, updatedStudio *models.Studio) error
	UpdateImage(ctx context.Context, studioID int, image []byte) error
	UpdateAliases(ctx context.Context, studioID int, aliases []string) error
	UpdateStashIDs(ctx context.Context, studioID int, stashIDs []models.StashID) error
}

var ErrParentStudioNotExist = errors.New("parent studio does not exist")

type Importer struct {
	ReaderWriter        NameFinderCreatorUpdater
	Input               jsonschema.Studio
	MissingRefBehaviour models.ImportMissingRefEnum

	studio    models.Studio
	imageData []byte
}

func (i *Importer) PreImport(ctx context.Context) error {
	checksum := md5.FromString(i.Input.Name)

	i.studio = models.Studio{
		Checksum:      checksum,
		Name:          i.Input.Name,
		URL:           i.Input.URL,
		Details:       i.Input.Details,
		IgnoreAutoTag: i.Input.IgnoreAutoTag,
		CreatedAt:     i.Input.CreatedAt.GetTime(),
		UpdatedAt:     i.Input.UpdatedAt.GetTime(),
		Rating:        &i.Input.Rating,
	}

	if err := i.populateParentStudio(ctx); err != nil {
		return err
	}

	var err error
	if len(i.Input.Image) > 0 {
		i.imageData, err = utils.ProcessBase64Image(i.Input.Image)
		if err != nil {
			return fmt.Errorf("invalid image: %v", err)
		}
	}

	return nil
}

func (i *Importer) populateParentStudio(ctx context.Context) error {
	if i.Input.ParentStudio != "" {
		studio, err := i.ReaderWriter.FindByName(ctx, i.Input.ParentStudio, false)
		if err != nil {
			return fmt.Errorf("error finding studio by name: %v", err)
		}

		if studio == nil {
			if i.MissingRefBehaviour == models.ImportMissingRefEnumFail {
				return ErrParentStudioNotExist
			}

			if i.MissingRefBehaviour == models.ImportMissingRefEnumIgnore {
				return nil
			}

			if i.MissingRefBehaviour == models.ImportMissingRefEnumCreate {
				parentID, err := i.createParentStudio(ctx, i.Input.ParentStudio)
				if err != nil {
					return err
				}
				i.studio.ParentID = &parentID
			}
		} else {
			i.studio.ParentID = &studio.ID
		}
	}

	return nil
}

func (i *Importer) createParentStudio(ctx context.Context, name string) (int, error) {
	newStudio := models.NewStudio(name)

	err := i.ReaderWriter.Create(ctx, newStudio)
	if err != nil {
		return 0, err
	}

	return newStudio.ID, nil
}

func (i *Importer) PostImport(ctx context.Context, id int) error {
	if len(i.imageData) > 0 {
		if err := i.ReaderWriter.UpdateImage(ctx, id, i.imageData); err != nil {
			return fmt.Errorf("error setting studio image: %v", err)
		}
	}

	if len(i.Input.StashIDs) > 0 {
		if err := i.ReaderWriter.UpdateStashIDs(ctx, id, i.Input.StashIDs); err != nil {
			return fmt.Errorf("error setting stash id: %v", err)
		}
	}

	if err := i.ReaderWriter.UpdateAliases(ctx, id, i.Input.Aliases); err != nil {
		return fmt.Errorf("error setting tag aliases: %v", err)
	}

	return nil
}

func (i *Importer) Name() string {
	return i.Input.Name
}

func (i *Importer) FindExistingID(ctx context.Context) (*int, error) {
	const nocase = false
	existing, err := i.ReaderWriter.FindByName(ctx, i.Name(), nocase)
	if err != nil {
		return nil, err
	}

	if existing != nil {
		id := existing.ID
		return &id, nil
	}

	return nil, nil
}

func (i *Importer) Create(ctx context.Context) (*int, error) {
	err := i.ReaderWriter.Create(ctx, &i.studio)
	if err != nil {
		return nil, fmt.Errorf("error creating studio: %v", err)
	}

	id := i.studio.ID
	return &id, nil
}

func (i *Importer) Update(ctx context.Context, id int) error {
	studio := i.studio
	studio.ID = id
	err := i.ReaderWriter.Update(ctx, &studio)
	if err != nil {
		return fmt.Errorf("error updating existing studio: %v", err)
	}

	return nil
}
