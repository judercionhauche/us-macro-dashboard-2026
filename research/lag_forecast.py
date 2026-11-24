"""Isolated Lag-Llama inference process."""
import json
import sys

import numpy as np


def lag_llama(values):
    from huggingface_hub import hf_hub_download
    from gluonts.dataset.common import ListDataset
    from lag_llama.gluon.estimator import LagLlamaEstimator
    import torch
    from gluonts.torch.distributions.studentT import StudentTOutput
    from gluonts.torch.modules.loss import NegativeLogLikelihood
    torch.set_num_threads(1)
    torch.manual_seed(244)
    torch.serialization.add_safe_globals([StudentTOutput, NegativeLogLikelihood])
    path = hf_hub_download("time-series-foundation-models/Lag-Llama", "lag-llama.ckpt",
                           local_files_only=True)
    cfg = torch.load(path, map_location="cpu", weights_only=True)["hyper_parameters"]["model_kwargs"]
    model = LagLlamaEstimator(ckpt_path=path, prediction_length=4, context_length=32,
                             num_parallel_samples=100, device=torch.device("cpu"),
                             **{k:cfg[k] for k in ("input_size", "n_layer", "n_embd_per_head",
                                                   "n_head", "scaling", "time_feat")})
    prediction = model.create_predictor(model.create_transformation(), model.create_lightning_module())
    # A synthetic origin avoids giving the model an issuer or a calendar date.
    dataset = ListDataset([{"start":"2000-01-01", "target": np.asarray(values)}], freq="Q")
    return next(prediction.predict(dataset)).samples.tolist()



if __name__ == "__main__":
    result = lag_llama(json.load(sys.stdin))
    print(json.dumps(result))
