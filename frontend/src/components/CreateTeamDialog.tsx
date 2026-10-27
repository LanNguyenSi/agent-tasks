"use client";

import Modal from "./ui/Modal";
import CreateTeamForm from "./CreateTeamForm";

interface CreateTeamDialogProps {
  open: boolean;
  onClose: () => void;
}

/** "New team" dialog for a user who already has a team. */
export default function CreateTeamDialog({ open, onClose }: CreateTeamDialogProps) {
  return (
    <Modal open={open} onClose={onClose} title="New team">
      <CreateTeamForm onCancel={onClose} onCreated={onClose} />
    </Modal>
  );
}
